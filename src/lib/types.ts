export type Color = 'white' | 'black'
export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical'

export interface Settings {
  elo: number
  color: Color
  speed: Speed
  /** Nombre de lignes du répertoire (feuilles de l'arbre). */
  budget: number
  /** Profondeur du répertoire, en coups complets. */
  maxMoves: number
  /** Nombre de coups proposés par Stockfish à mon tour (MultiPV). */
  multiPv: number
  /** Perte d'évaluation max (en centipions) d'un coup proposé par rapport au meilleur. */
  maxLoss: number
  /** Un coup adverse n'entre dans le répertoire que s'il a été joué au moins ce nombre de fois. */
  minGames: number
  /** Profondeur de recherche Stockfish. */
  depth: number
  /** Jeton d'accès personnel Lichess (requis par l'Opening Explorer). */
  token: string
}

export const DEFAULT_SETTINGS: Settings = {
  elo: 1500,
  color: 'white',
  speed: 'blitz',
  budget: 20,
  maxMoves: 10,
  multiPv: 3,
  maxLoss: 50,
  minGames: 30,
  depth: 14,
  token: '',
}

/** Un coup que Stockfish me propose dans une position. */
export interface Candidate {
  uci: string
  san: string
  /** Éval après le coup, en centipions, du point de vue des Blancs. */
  evalWhite: number
  /** Perte par rapport au meilleur coup du moteur, en centipions (≥ 0). */
  loss: number
  /** Part des joueurs de mon niveau qui jouent ce coup (0..1). */
  share: number
  /** Parties où ce coup a été joué à mon niveau. */
  games: number
  /** Score obtenu avec ce coup à mon niveau (0..1, nulle = ½), si des parties existent. */
  score?: number
}

/** Un coup adverse joué à mon niveau, d'après l'Opening Explorer. */
export interface OppMove {
  san: string
  /** Fréquence parmi les parties de la position (0..1). */
  share: number
  /** Parties où ce coup a été joué. */
  games: number
}

export interface RepNode {
  /** Chemin des coups SAN depuis la racine, ex. "e4/c5/Nf3". */
  id: string
  fen: string
  uci: string | null
  san: string | null
  /** Demi-coups joués depuis la position initiale. */
  ply: number
  /** Qui a joué le coup menant à ce nœud. */
  mover: 'me' | 'opp' | null
  /** Fréquence du coup parmi les parties de l'Explorer à la position parente (0..1). */
  share: number
  /** Parties dans l'Explorer à cette position. */
  games: number
  /** Parties où le coup menant ici a été joué (base de `share`). */
  moveGames?: number
  /** Position déjà présente ailleurs dans l'arbre (même position, même demi-coup) : id du nœud de référence. */
  transposeTo?: string
  /** Éval de la position en centipions, du point de vue des Blancs. */
  evalWhite?: number
  /** Pour un coup adverse : centipions perdus par l'adversaire en le jouant. */
  oppLoss?: number
  /** Coup adverse fréquent mais mauvais. */
  trap?: boolean
  /** À mon tour : les coups proposés par Stockfish (vide si la partie est finie). */
  candidates?: Candidate[]
  /** Au tour adverse : les coups joués à mon niveau, du plus au moins fréquent. */
  oppMoves?: OppMove[]
  children: RepNode[]
}

export interface Repertoire {
  settings: Settings
  root: RepNode
  /** La position de travail : là où la construction en est. */
  cursorId: string
  createdAt: string
}
