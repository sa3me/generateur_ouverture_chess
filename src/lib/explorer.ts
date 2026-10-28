import { cacheGet, cacheSet } from './cache'
import type { Speed } from './types'

export interface ExplorerMove {
  uci: string
  san: string
  white: number
  draws: number
  black: number
  averageRating: number
}

export interface ExplorerData {
  white: number
  draws: number
  black: number
  moves: ExplorerMove[]
  opening: { eco: string; name: string } | null
}

export interface ExplorerQuery {
  elo: number
  speed: Speed
  token: string
}

export const stats = { requests: 0, cacheHits: 0 }

/** Tranches d'Elo de l'Explorer : chaque valeur est la borne basse d'une tranche. */
const BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]

/** Les tranches qui recoupent [elo - 150, elo + 150]. */
export function ratingBuckets(elo: number): number[] {
  const lo = elo - 150
  const hi = elo + 150
  return BUCKETS.filter((b, i) => {
    const next = BUCKETS[i + 1] ?? Infinity
    return b <= hi && next > lo
  })
}

export function totalGames(d: { white: number; draws: number; black: number }): number {
  return d.white + d.draws + d.black
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function explore(fen: string, q: ExplorerQuery, signal?: AbortSignal): Promise<ExplorerData> {
  const params = new URLSearchParams({
    variant: 'standard',
    speeds: q.speed,
    ratings: ratingBuckets(q.elo).join(','),
    fen,
    moves: '20',
    topGames: '0',
    recentGames: '0',
  })
  const url = `https://explorer.lichess.ovh/lichess?${params}`

  const cached = await cacheGet<ExplorerData>(url)
  if (cached) {
    stats.cacheHits++
    return cached
  }

  for (;;) {
    stats.requests++
    const res = await fetch(url, {
      headers: q.token ? { Authorization: `Bearer ${q.token}` } : {},
      signal,
    })
    if (res.status === 429) {
      // Lichess demande d'attendre une minute après un 429.
      await sleep(60_000)
      continue
    }
    if (res.status === 401) {
      throw new Error('Lichess refuse la requête : il faut un jeton d’accès personnel valide (lichess.org/account/oauth/token).')
    }
    if (!res.ok) throw new Error(`Opening Explorer : erreur HTTP ${res.status}`)
    const data = (await res.json()) as ExplorerData
    await cacheSet(url, data)
    return data
  }
}
