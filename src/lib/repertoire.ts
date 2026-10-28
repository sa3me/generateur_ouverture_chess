import { Chess } from 'chess.js'
import type { Engine } from './engine'
import { explore, totalGames } from './explorer'
import type { Color, OppMove, RepNode, Settings } from './types'

/** Seuils du détecteur de pièges. */
const TRAP_MIN_SHARE = 0.1
const TRAP_MIN_LOSS = 120
/** Au-delà, une position est gagnante et les écarts ne veulent plus dire grand-chose. */
const EVAL_CLAMP = 1500

const whiteToMove = (fen: string) => fen.split(' ')[1] === 'w'

export function isMyTurn(fen: string, color: Color): boolean {
  return whiteToMove(fen) === (color === 'white')
}

export function createRoot(): RepNode {
  return { id: '', fen: new Chess().fen(), uci: null, san: null, ply: 0, mover: null, share: 1, games: 0, children: [] }
}

export function playMove(parent: RepNode, san: string, mover: 'me' | 'opp', share: number, moveGames?: number): RepNode {
  const chess = new Chess(parent.fen)
  const m = chess.move(san)
  return {
    id: parent.id ? `${parent.id}/${m.san}` : m.san,
    fen: chess.fen(),
    uci: m.from + m.to + (m.promotion ?? ''),
    san: m.san,
    ply: parent.ply + 1,
    mover,
    share,
    games: 0,
    moveGames,
    children: [],
  }
}

export function findNode(root: RepNode, id: string): RepNode | undefined {
  let node: RepNode | undefined = root
  for (const san of id ? id.split('/') : []) {
    node = node?.children.find((c) => c.san === san)
  }
  return node
}

export function parentOf(root: RepNode, node: RepNode): RepNode | undefined {
  return node.id ? findNode(root, node.id.split('/').slice(0, -1).join('/')) : undefined
}

function allNodes(node: RepNode, out: RepNode[] = []): RepNode[] {
  out.push(node)
  for (const c of node.children) allNodes(c, out)
  return out
}

/** La position sans les compteurs de coups : deux ordres de coups différents donnent la même clé. */
const positionKey = (n: RepNode) => `${n.fen.split(' ').slice(0, 4).join(' ')} @${n.ply}`

/** Le nœud qui porte déjà la position de `node` ailleurs dans l'arbre, s'il existe. */
export function findTransposition(root: RepNode, node: RepNode): RepNode | undefined {
  const key = positionKey(node)
  return allNodes(root).find((n) => n !== node && !n.transposeTo && positionKey(n) === key)
}

/** Après un effacement, un renvoi dont la cible a disparu redevient une ligne à part entière. */
export function repairTranspositions(root: RepNode) {
  for (const n of allNodes(root)) {
    if (n.transposeTo && !findNode(root, n.transposeTo)) n.transposeTo = undefined
  }
}

/** « 1.d4 d5 2.Nf3 Nf6 » à partir d'un id de nœud. */
export function lineText(id: string): string {
  return id
    .split('/')
    .filter(Boolean)
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}.${san}` : san))
    .join(' ')
}

function markTrap(parent: RepNode, child: RepNode, color: Color) {
  if (parent.evalWhite == null || child.evalWhite == null) return
  const clamp = (v: number) => Math.max(-EVAL_CLAMP, Math.min(EVAL_CLAMP, v))
  const mySign = color === 'white' ? 1 : -1
  child.oppLoss = Math.max(0, (clamp(child.evalWhite) - clamp(parent.evalWhite)) * mySign)
  child.trap = child.share >= TRAP_MIN_SHARE && child.oppLoss >= TRAP_MIN_LOSS
}

/** À mon tour : les meilleurs coups de Stockfish, avec leur popularité et leur score à mon niveau. */
export async function analyzeMyTurn(node: RepNode, parent: RepNode | undefined, s: Settings, engine: Engine) {
  const data = await explore(node.fen, s)
  const total = totalGames(data)
  node.games = total
  const lines = await engine.analyze(node.fen, s.multiPv, s.depth)
  node.candidates = []
  if (lines.length === 0) return // mat ou pat
  const sign = whiteToMove(node.fen) ? 1 : -1
  node.evalWhite = lines[0].cp * sign
  const chess = new Chess(node.fen)
  node.candidates = lines
    .map((l) => {
      const m = chess.move({ from: l.uci.slice(0, 2), to: l.uci.slice(2, 4), promotion: l.uci[4] })
      chess.undo()
      const pop = data.moves.find((x) => x.san === m.san)
      const games = pop ? totalGames(pop) : 0
      const wins = pop ? (s.color === 'white' ? pop.white : pop.black) : 0
      return {
        uci: l.uci,
        san: m.san,
        evalWhite: l.cp * sign,
        loss: lines[0].cp - l.cp,
        share: total ? games / total : 0,
        games,
        score: games ? (wins + pop!.draws / 2) / games : undefined,
      }
    })
    .filter((c, i) => i === 0 || c.loss <= s.maxLoss)
  if (parent && node.mover === 'opp') markTrap(parent, node, s.color)
}

/** Au tour adverse : les coups joués à mon niveau, et l'éval qui sert au détecteur de pièges. */
export async function analyzeOppTurn(node: RepNode, s: Settings, engine: Engine) {
  const data = await explore(node.fen, s)
  const total = totalGames(data)
  node.games = total
  node.oppMoves = total
    ? data.moves.map((m) => ({ san: m.san, share: totalGames(m) / total, games: totalGames(m) }))
    : []
  const lines = await engine.analyze(node.fen, 1, s.depth)
  if (lines.length) node.evalWhite = lines[0].cp * (whiteToMove(node.fen) ? 1 : -1)
}

/** Les coups adverses assez joués pour qu'on s'y fie, du plus au moins fréquent. */
export function reliableOppMoves(node: RepNode, s: Settings): OppMove[] {
  // `games` manque dans les répertoires enregistrés avant son ajout : on garde alors le coup.
  return (node.oppMoves ?? []).filter((m) => (m.games ?? s.minGames) >= s.minGames)
}

/**
 * Probabilité d'atteindre chaque nœud, par id. Une position atteinte par plusieurs ordres de coups
 * cumule les probabilités de tous ses chemins ; on traite donc les nœuds demi-coup par demi-coup.
 */
export function reachById(root: RepNode): Map<string, number> {
  const nodes = allNodes(root).sort((a, b) => a.ply - b.ply || (a.transposeTo ? 0 : 1) - (b.transposeTo ? 0 : 1))
  const reach = new Map<string, number>([[root.id, 1]])
  for (const n of nodes) {
    const r = reach.get(n.id) ?? 0
    if (n.transposeTo) reach.set(n.transposeTo, (reach.get(n.transposeTo) ?? 0) + r)
    for (const c of n.children) reach.set(c.id, (reach.get(c.id) ?? 0) + (c.mover === 'opp' ? r * c.share : r))
  }
  return reach
}

export interface Work {
  node: RepNode
  /** Probabilité de rencontrer ce travail en partie. */
  reach: number
  /** Coup adverse à ouvrir depuis `node` ; absent s'il s'agit de finir une ligne commencée. */
  move?: OppMove
}

/**
 * Le prochain travail, toujours le plus probable : finir une ligne inachevée,
 * ou ouvrir la réponse adverse pas encore préparée qui arrive le plus souvent (si `openNew`).
 */
export function nextWork(root: RepNode, s: Settings, openNew: boolean): Work | null {
  const maxPly = s.maxMoves * 2
  const reach = reachById(root)
  let best: Work | null = null
  const consider = (w: Work) => {
    if (!best || w.reach > best.reach) best = w
  }
  for (const node of allNodes(root)) {
    if (node.transposeTo || node.ply >= maxPly) continue
    const r = reach.get(node.id) ?? 0
    const mine = isMyTurn(node.fen, s.color)
    if (node.children.length === 0) {
      const unfinished = mine
        ? node.candidates === undefined || node.candidates.length > 0
        : node.oppMoves === undefined || reliableOppMoves(node, s).length > 0
      if (unfinished) consider({ node, reach: r })
    } else if (openNew && !mine) {
      const move = reliableOppMoves(node, s).find((m) => !node.children.some((c) => c.san === m.san))
      if (move) consider({ node, reach: r * move.share, move })
    }
  }
  return best
}

/** Probabilité de rester dans le répertoire jusqu'au demi-coup `ply`, face aux adversaires de l'Explorer. */
export function coverage(root: RepNode, ply: number, color: Color): number {
  const rec = (node: RepNode): number => {
    if (node.ply >= ply) return 1
    if (node.transposeTo) {
      const target = findNode(root, node.transposeTo)
      return target ? rec(target) : 0
    }
    if (node.children.length === 0) return 0
    if (isMyTurn(node.fen, color)) return rec(node.children[0])
    return node.children.reduce((sum, c) => sum + c.share * rec(c), 0)
  }
  return rec(root)
}

/** Lignes à apprendre : les fins de ligne, sauf les renvois vers une position déjà préparée. */
export function countLines(node: RepNode): number {
  if (node.children.length === 0) return node.transposeTo ? 0 : 1
  return node.children.reduce((n, c) => n + countLines(c), 0)
}

export interface TrapHit {
  node: RepNode
  /** Probabilité d'atteindre ce coup piège depuis la racine. */
  reach: number
}

export function collectTraps(root: RepNode): TrapHit[] {
  const reach = reachById(root)
  return allNodes(root)
    .filter((n) => n.trap)
    .map((node) => ({ node, reach: reach.get(node.id) ?? 0 }))
    .sort((a, b) => b.reach - a.reach)
}
