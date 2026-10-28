import { describe, expect, it } from 'vitest'
import {
  countLines,
  coverage,
  createRoot,
  findNode,
  findTransposition,
  lineText,
  nextWork,
  playMove,
  reachById,
  repairTranspositions,
} from './repertoire'
import { DEFAULT_SETTINGS, type RepNode } from './types'

const s = { ...DEFAULT_SETTINGS, maxMoves: 3 }

function add(parent: RepNode, san: string, mover: 'me' | 'opp', share = 1): RepNode {
  const child = playMove(parent, san, mover, share)
  parent.children.push(child)
  return child
}

/**
 * 1.d4 d5 (60 %) 2.Nf3 Nf6 (50 %)
 * 1.d4 Nf6 (30 %) 2.Nf3 d5 (40 %)  → même position, par un autre ordre de coups
 */
function transposingTree() {
  const root = createRoot()
  const d4 = add(root, 'd4', 'me')
  const a = add(add(add(d4, 'd5', 'opp', 0.6), 'Nf3', 'me'), 'Nf6', 'opp', 0.5)
  const b = add(add(add(d4, 'Nf6', 'opp', 0.3), 'Nf3', 'me'), 'd5', 'opp', 0.4)
  return { root, a, b }
}

describe('transpositions', () => {
  it('reconnaît la même position atteinte par un autre ordre de coups', () => {
    const { root, a, b } = transposingTree()
    expect(findTransposition(root, b)).toBe(a)
    expect(findTransposition(root, findNode(root, 'd4/d5')!)).toBeUndefined()
  })

  it('cumule les probabilités des deux chemins sur la position commune', () => {
    const { root, a, b } = transposingTree()
    b.transposeTo = a.id
    add(a, 'c4', 'me')
    const reach = reachById(root)
    expect(reach.get(a.id)).toBeCloseTo(0.6 * 0.5 + 0.3 * 0.4)
    expect(reach.get(`${a.id}/c4`)).toBeCloseTo(0.42)
    // La couverture suit le renvoi : jusqu'au demi-coup 5, les deux chemins restent dans le répertoire.
    expect(coverage(root, 5, 'white')).toBeCloseTo(0.42)
  })

  it('un renvoi ne compte pas comme une ligne à apprendre ni comme un travail à finir', () => {
    const { root, a, b } = transposingTree()
    b.transposeTo = a.id
    expect(countLines(root)).toBe(1)
    expect(nextWork(root, s, false)?.node).toBe(a)
  })

  it('un renvoi dont la cible est effacée redevient une ligne normale', () => {
    const { root, a, b } = transposingTree()
    b.transposeTo = a.id
    findNode(root, 'd4')!.children.shift()
    repairTranspositions(root)
    expect(b.transposeTo).toBeUndefined()
  })

  it('écrit une ligne lisible', () => {
    expect(lineText('d4/d5/Nf3/Nf6')).toBe('1.d4 d5 2.Nf3 Nf6')
  })
})

describe('fiabilité', () => {
  it('n’ouvre pas de branche sur un coup adverse trop peu joué', () => {
    const root = createRoot()
    const d4 = add(root, 'd4', 'me')
    d4.oppMoves = [
      { san: 'd5', share: 0.9, games: 900 },
      { san: 'e5', share: 0.02, games: 12 },
    ]
    add(d4, 'd5', 'opp', 0.9).candidates = []
    expect(nextWork(root, { ...s, minGames: 30 }, true)).toBeNull()
    expect(nextWork(root, { ...s, minGames: 10 }, true)?.move?.san).toBe('e5')
  })
})
