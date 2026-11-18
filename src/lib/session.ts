import type { Engine } from './engine'
import { explore, totalGames } from './explorer'
import {
  analyzeMyTurn,
  analyzeOppTurn,
  countLines,
  findNode,
  findTransposition,
  isMyTurn,
  myMoveLoss,
  nextWork,
  parentOf,
  playMove,
  reliableOppMoves,
  repairTranspositions,
  sanOf,
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
  private phase: Phase = 'idle'

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
      this.setPhase('choose')
    } else {
      void this.run(null)
    }
  }

  /** Je joue un coup à la position de travail. */
  play(uci: string) {
    this.branch(this.rep.cursorId, uci)
  }

  /**
   * Joue un coup depuis n'importe quelle position de l'arbre : il pousse une nouvelle branche,
   * et la construction continue depuis elle. La ligne qu'on quitte sera finie plus tard.
   * À mon tour, tout coup légal est accepté ; sa perte face au meilleur coup est notée.
   */
  branch(fromId: string, uci: string) {
    const s = this.rep.settings
    const node = findNode(this.rep.root, fromId)
    const san = node && sanOf(node.fen, uci)
    if (!node || !san || this.phase === 'busy') return
    if (node.transposeTo || node.ply >= s.maxMoves * 2 || node.children.some((c) => c.san === san)) return
    void this.run(async () => [node, await this.grow(node, san)])
  }

  /** Le nouveau nœud, avec la fréquence du coup à mon niveau (et sa perte, si c'est le mien). */
  private async grow(node: RepNode, san: string): Promise<RepNode> {
    const s = this.rep.settings
    if (!isMyTurn(node.fen, s.color)) {
      if (!node.oppMoves) await analyzeOppTurn(node, s, this.engine)
      const m = node.oppMoves?.find((x) => x.san === san)
      return playMove(node, san, 'opp', m?.share ?? 0, m?.games ?? 0)
    }
    if (!node.candidates) await analyzeMyTurn(node, parentOf(this.rep.root, node), s, this.engine)
    const c = node.candidates?.find((x) => x.san === san)
    if (c) {
      const child = playMove(node, san, 'me', c.share, c.games)
      child.myLoss = c.loss
      return child
    }
    // Coup hors des propositions de Stockfish : fréquence via l'Explorer, perte via l'éval de la position atteinte.
    const data = await explore(node.fen, s)
    const total = totalGames(data)
    const pop = data.moves.find((x) => x.san === san)
    const games = pop ? totalGames(pop) : 0
    const child = playMove(node, san, 'me', total ? games / total : 0, games)
    await analyzeOppTurn(child, s, this.engine)
    child.myLoss = myMoveLoss(node, child, s.color)
    return child
  }

  /**
   * Retire un de mes coups et sa suite. S'il était seul à cette position, on rechoisit depuis là ;
   * sinon, il s'agissait d'une variante, et la construction reprend où elle en est.
   */
  replace(id: string) {
    const node = findNode(this.rep.root, id)
    const parent = node && parentOf(this.rep.root, node)
    if (!node || !parent || node.mover !== 'me' || this.phase === 'busy') return
    parent.children = parent.children.filter((c) => c !== node)
    repairTranspositions(this.rep.root)
    void this.run(parent.children.length === 0 ? parent : null)
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

  private setPhase(p: Phase) {
    this.phase = p
    this.events.onPhase(p)
  }

  private focus(node: RepNode) {
    this.rep.cursorId = node.id
    this.events.onFocus(node.id)
    this.events.onUpdate()
  }

  /**
   * Avance depuis `start` jusqu'à mon prochain choix ; en fin de ligne, enchaîne sur le travail suivant.
   * `start` peut aussi préparer un coup à ajouter : il n'est accroché à l'arbre que si la session n'a pas été arrêtée.
   */
  private async run(start: RepNode | null | (() => Promise<[RepNode, RepNode]>)): Promise<void> {
    const token = ++this.token
    const live = () => token === this.token
    const s = this.rep.settings
    const root = this.rep.root
    this.setPhase('busy')
    try {
      let node: RepNode | null
      if (typeof start === 'function') {
        const [parent, child] = await start()
        if (!live()) return
        node = this.attach(parent, child)
      } else {
        node = start
      }
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
            this.setPhase('choose')
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
        this.setPhase('done')
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
      this.setPhase('idle')
    }
  }
}
