import { Chess } from 'chess.js'
import { describe, expect, it, vi } from 'vitest'
import type { Engine, PvLine } from './engine'
import type { ExplorerData } from './explorer'
import { toPgn } from './pgn'
import { countLines, coverage, createRoot, findNode, nextWork } from './repertoire'
import { Session, type Phase } from './session'
import { DEFAULT_SETTINGS, type Repertoire, type Settings } from './types'

// Explorer simulé : à chaque position, les 4 premiers coups légaux (ordre alphabétique) aux fréquences 50/30/15/5.
vi.mock('./explorer', async (orig) => {
  const actual = await orig<typeof import('./explorer')>()
  return {
    ...actual,
    explore: async (fen: string): Promise<ExplorerData> => {
      const counts = [500, 300, 150, 50]
      const sans = new Chess(fen).moves().sort().slice(0, 4)
      const moves = sans.map((san, i) => ({ uci: '', san, white: counts[i], draws: 0, black: 0, averageRating: 1500 }))
      return { white: 1000, draws: 0, black: 0, moves, opening: null }
    },
  }
})

// Moteur simulé : classe les coups légaux par ordre alphabétique, chacun perdant 10 cp sur le précédent.
const fakeEngine = {
  analyze: async (fen: string, multiPv: number): Promise<PvLine[]> => {
    const moves = new Chess(fen).moves({ verbose: true }).sort((a, b) => a.san.localeCompare(b.san))
    return moves.slice(0, multiPv).map((m, i) => ({ uci: m.from + m.to, cp: -i * 10 }))
  },
} as unknown as Engine

const settings: Settings = { ...DEFAULT_SETTINGS, budget: 4, maxMoves: 3, multiPv: 3, token: 'x' }

function newRep(s: Settings = settings): Repertoire {
  return { settings: { ...s }, root: createRoot(), cursorId: '', createdAt: '2026-10-26T00:00:00Z' }
}

/** Lance une session et renvoie une fonction qui attend la prochaine phase « stable ». */
function startSession(rep: Repertoire) {
  let waiting: ((p: Phase) => void) | null = null
  const session = new Session(
    rep,
    fakeEngine,
    {
      onUpdate: () => {},
      onFocus: () => {},
      onPhase: (p) => {
        if (p !== 'busy') waiting?.(p)
      },
      onError: (m) => {
        throw new Error(m)
      },
    },
    0,
  )
  const next = (act: () => void) =>
    new Promise<Phase>((resolve) => {
      waiting = resolve
      act()
    })
  return { session, next }
}

describe('Session', () => {
  it('attend mon choix, fait répondre le coup adverse le plus fréquent, puis rend la main', async () => {
    const rep = newRep()
    const { session, next } = startSession(rep)
    expect(await next(() => session.resume())).toBe('choose')
    expect(rep.cursorId).toBe('')
    expect(rep.root.candidates).toHaveLength(3)

    // Je joue le 2e candidat : l'adversaire répond par son coup le plus fréquent, seul dans l'arbre.
    const pick = rep.root.candidates![1]
    expect(await next(() => session.play(pick.uci))).toBe('choose')
    const me = rep.root.children[0]
    expect(me.san).toBe(pick.san)
    expect(me.children).toHaveLength(1)
    expect(me.children[0].share).toBe(0.5)
    expect(rep.cursorId).toBe(me.children[0].id)
  })

  it('refuse un coup qui n’est pas proposé par Stockfish', async () => {
    const rep = newRep()
    const { session, next } = startSession(rep)
    await next(() => session.resume())
    session.play('h2h4')
    expect(rep.root.children).toHaveLength(0)
  })

  it('construit les lignes par ordre de probabilité jusqu’au budget', async () => {
    const rep = newRep()
    const { session, next } = startSession(rep)
    let phase = await next(() => session.resume())
    while (phase === 'choose') {
      phase = await next(() => session.play(session.cursor.candidates![0].uci))
    }
    expect(phase).toBe('done')
    expect(countLines(rep.root)).toBe(settings.budget)

    // Lignes ouvertes par probabilité : 50 % puis 30 % puis 15 % au 1er coup adverse,
    // puis 0,5 × 0,3 = 15 % au 2e coup adverse de la première ligne (avant 0,3 × 0,3 = 9 %).
    const myFirst = rep.root.children[0]
    expect(myFirst.children.map((c) => c.share)).toEqual([0.5, 0.3, 0.15])
    expect(myFirst.children[0].children[0].children.map((c) => c.share)).toEqual([0.5, 0.3])
    expect(myFirst.children[1].children[0].children.map((c) => c.share)).toEqual([0.5])
    expect(coverage(rep.root, 2, 'white')).toBeCloseTo(0.95)

    // + 5 lignes relance la construction.
    phase = await next(() => session.addLines(1))
    while (phase === 'choose') {
      phase = await next(() => session.play(session.cursor.candidates![0].uci))
    }
    expect(countLines(rep.root)).toBe(settings.budget + 1)

    expect(toPgn(rep)).toMatch(/^\[Event/)
  })

  it('remplacer un de mes coups efface sa suite et redemande mon choix', async () => {
    const rep = newRep()
    const { session, next } = startSession(rep)
    await next(() => session.resume())
    await next(() => session.play(rep.root.candidates![0].uci))
    const first = rep.root.children[0]
    expect(await next(() => session.replace(first.id))).toBe('choose')
    expect(rep.root.children).toHaveLength(0)
    expect(rep.cursorId).toBe('')
    expect(findNode(rep.root, first.id)).toBeUndefined()
  })
})

describe('seuil de parties', () => {
  it('écarte les coups adverses joués moins de minGames fois', async () => {
    // Le 4e coup adverse de l'Explorer simulé n'a que 50 parties.
    const rep = newRep({ ...settings, budget: 30, minGames: 100 })
    const { session, next } = startSession(rep)
    let phase = await next(() => session.resume())
    while (phase === 'choose') {
      phase = await next(() => session.play(session.cursor.candidates![0].uci))
    }
    const shares = new Set<number>()
    const walk = (n: typeof rep.root) => {
      if (n.mover === 'opp') shares.add(n.share)
      n.children.forEach(walk)
    }
    walk(rep.root)
    expect(shares.has(0.05)).toBe(false)
    expect(shares.has(0.15)).toBe(true)
  })
})

describe('nextWork', () => {
  it('ne propose pas de nouvelle branche quand on ne l’autorise pas', () => {
    const root = createRoot()
    root.candidates = []
    expect(nextWork(root, settings, true)).toBeNull()
    expect(nextWork(createRoot(), settings, false)?.node.id).toBe('')
  })
})
