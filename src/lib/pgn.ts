import { lineText } from './repertoire'
import type { RepNode, Repertoire } from './types'

const SPEED_FR = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapide', classical: 'Classique' }

function moveNumber(node: RepNode, force: boolean): string {
  if (node.ply % 2 === 1) return `${(node.ply + 1) / 2}. `
  return force ? `${node.ply / 2}... ` : ''
}

function comment(node: RepNode): string {
  const parts: string[] = []
  if (node.mover === 'opp') parts.push(`${Math.round(node.share * 100)} % des parties`)
  if (node.trap) parts.push(`Piège : coup fréquent qui perd ${(node.oppLoss! / 100).toFixed(1)}`)
  if (node.transposeTo) parts.push(`Transpose dans ${lineText(node.transposeTo)}`)
  return parts.length ? ` {${parts.join(' · ')}}` : ''
}

function nag(node: RepNode): string {
  return node.trap ? ' $2' : ''
}

/** Écrit la suite de `node` au format PGN, avec ses variantes entre parenthèses. */
function continuation(node: RepNode, forceNumber: boolean): string {
  if (node.children.length === 0) return ''
  const [main, ...others] = node.children
  let out = ` ${moveNumber(main, forceNumber)}${main.san}${nag(main)}${comment(main)}`
  for (const v of others) {
    out += ` (${moveNumber(v, true)}${v.san}${nag(v)}${comment(v)}${continuation(v, false)})`
  }
  return out + continuation(main, others.length > 0 || comment(main) !== '')
}

export function toPgn(rep: Repertoire): string {
  const s = rep.settings
  const color = s.color === 'white' ? 'Blancs' : 'Noirs'
  const headers = [
    ['Event', `Répertoire Verger — ${color}, ${SPEED_FR[s.speed]}, ${s.elo}`],
    ['Site', 'Verger'],
    ['Date', rep.createdAt.slice(0, 10).replaceAll('-', '.')],
    ['White', s.color === 'white' ? 'Moi' : '?'],
    ['Black', s.color === 'black' ? 'Moi' : '?'],
    ['Result', '*'],
  ]
  const head = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n')
  return `${head}\n\n${continuation(rep.root, false).trim()} *\n`
}
