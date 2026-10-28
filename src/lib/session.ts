import type { Engine } from './engine'
import {
  analyzeMyTurn,
  analyzeOppTurn,
  countLines,
  findNode,
  findTransposition,
  isMyTurn,
  nextWork,
  parentOf,
  playMove,
  reliableOppMoves,
  repairTranspositions,
} from './repertoire'
import type { RepNode, Repertoire } from './types'

/** busy : Lichess ou Stockfish travaillent · choose : à moi de jouer · done : budget atteint · idle : à l'arrêt. */
export type Phase = 'idle' | 'busy' | 'choose' | 'done'

export interface SessionEvents {
  onUpdate: () => void
  onFocus: (id: string) => void
  onPhase: (phase: Phase) => void
  onError: (message: string) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Construction pas à pas d'un répertoire : je choisis mes coups parmi ceux de Stockfish,
 * l'adversaire joue son coup le plus fréquent, et chaque nouvelle ligne s'ouvre sur
 * la réponse adverse non préparée la plus probable, jusqu'au budget de lignes.
 */
export class Session {
  readonly rep: Repertoire
  private engine: Engine
  private events: SessionEvents
  /** Pause entre deux coups joués par l'app, pour qu'on les voie sur le plateau. */
  private delay: number
  private token = 0

  constructor(rep: Repertoire, engine: Engine, events: SessionEvents, delay = 500) {
    this.rep = rep
    this.engine = engine
    this.events = events
    this.delay = delay
  }

  get cursor(): RepNode {
    return findNode(this.rep.root, this.rep.cursorId) ?? this.rep.root
  }

  /** Reprend là où la construction s'était arrêtée. */
  resume() {
    const node = this.cursor
    if (this.awaitsMyChoice(node)) {
      this.focus(node)
      this.events.onPhase('choose')
    } else {
      void this.run(null)
    }
  }

  /** Je joue un des coups proposés à la position de travail. */
  play(uci: string) {
    const node = this.cursor
    const c = node.candidates?.find((x) => x.uci === uci)
    if (!c || !this.awaitsMyChoice(node)) return
    void this.run(this.attach(node, playMove(node, c.san, 'me', c.share, c.games)))
  }

  /** Revient sur un de mes coups : sa suite est effacée et on rechoisit depuis la position d'avant. */
  replace(id: string) {
    const node = findNode(this.rep.root, id)
    const parent = node && parentOf(this.rep.root, node)
    if (!node || !parent || node.mover !== 'me') return
    parent.children = []
    repairTranspositions(this.rep.root)
    void this.run(parent)
  }

  addLines(n: number) {
    this.rep.settings.budget += n
    void this.run(null)
  }

  stop() {
    this.token++
  }

  private awaitsMyChoice(node: RepNode): boolean {
    const s = this.rep.settings
    return (
      isMyTurn(node.fen, s.color) &&
      node.ply < s.maxMoves * 2 &&
      node.children.length === 0 &&
      (node.candidates?.length ?? 0) > 0
    )
  }

  /** Ajoute un coup à l'arbre ; s'il mène à une position déjà préparée, il devient un renvoi vers elle. */
  private attach(parent: RepNode, child: RepNode): RepNode {
    parent.children.push(child)
    child.transposeTo = findTransposition(this.rep.root, child)?.id
    return child
  }

  private focus(node: RepNode) {
    this.rep.cursorId = node.id
    this.events.onFocus(node.id)
    this.events.onUpdate()
  }

  /** Avance depuis `start` jusqu'à mon prochain choix ; en fin de ligne, enchaîne sur le travail suivant. */
  private async run(start: RepNode | null): Promise<void> {
    const token = ++this.token
    const live = () => token === this.token
    const s = this.rep.settings
    const root = this.rep.root
    this.events.onPhase('busy')
    try {
      let node = start
      while (node) {
        const cur: RepNode = node
        this.focus(cur)
        if (cur.transposeTo) {
          // Position déjà préparée par un autre ordre de coups : la ligne s'arrête ici.
          node = null
        } else if (isMyTurn(cur.fen, s.color)) {
          if (!cur.candidates) await analyzeMyTurn(cur, parentOf(root, cur), s, this.engine)
          if (!live()) return
          this.events.onUpdate()
          if (this.awaitsMyChoice(cur)) {
            this.events.onPhase('choose')
            return
          }
          node = null
        } else if (cur.ply < s.maxMoves * 2) {
          if (!cur.oppMoves) await analyzeOppTurn(cur, s, this.engine)
          if (!live()) return
          const top = reliableOppMoves(cur, s).find((m) => !cur.children.some((c) => c.san === m.san))
          if (!top) break
          await sleep(this.delay)
          if (!live()) return
          node = this.attach(cur, playMove(cur, top.san, 'opp', top.share, top.games))
        } else {
          node = null
        }
      }

      // Fin de ligne : on ouvre la branche la plus probable, tant que le budget le permet.
      const work = nextWork(root, s, countLines(root) < s.budget)
      if (!work) {
        this.events.onUpdate()
        this.events.onPhase('done')
        return
      }
      if (!work.move) return this.run(work.node)
      this.focus(work.node)
      await sleep(this.delay * 2)
      if (!live()) return
      return this.run(this.attach(work.node, playMove(work.node, work.move.san, 'opp', work.move.share, work.move.games)))
    } catch (e) {
      if (!live()) return
      this.events.onError((e as Error).message)
      this.events.onPhase('idle')
    }
  }
}
