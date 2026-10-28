import { useEffect, useRef, useState } from 'react'
import { lineText } from '../lib/repertoire'
import type { RepNode } from '../lib/types'

interface Props {
  root: RepNode
  /** Probabilité d'atteindre chaque nœud, transpositions comprises. */
  reach: Map<string, number>
  selectedId: string
  /** La position de travail, entourée d'un anneau. */
  cursorId: string
  onSelect: (id: string) => void
}

/** Largeur d'une colonne (une ligne du répertoire), hauteur d'un demi-coup, rayon d'un coup. */
const COL = 62
const ROW = 70
const R = 23
const PAD = 36

const FIGURINES: Record<string, string> = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' }

/** Le coup avec la pièce en figurine, un peu plus grande que le texte. */
function Label({ san }: { san: string }) {
  const piece = FIGURINES[san[0]]
  if (!piece) return <>{san}</>
  return (
    <>
      <tspan className="piece">{piece}</tspan>
      {san.slice(1)}
    </>
  )
}

const pct = (x: number) => `${Math.round(x * 100)}%`

interface Placed {
  node: RepNode
  /** Colonne, éventuellement fractionnaire (centre de ses branches). */
  x: number
  children: Placed[]
}

/** Chaque ligne occupe une colonne ; un embranchement se place au milieu de ses branches. */
function place(node: RepNode, next: { col: number }): Placed {
  const children = node.children.map((c) => place(c, next))
  const x = children.length ? (children[0].x + children.at(-1)!.x) / 2 : next.col++
  return { node, x, children }
}

function flatten(p: Placed, out: Placed[] = []): Placed[] {
  out.push(p)
  for (const c of p.children) flatten(c, out)
  return out
}

function tooltip(n: RepNode, reach: number): string {
  const games = n.moveGames != null ? ` (${n.moveGames.toLocaleString('fr-FR')} parties)` : ''
  const who = n.mover === 'me' ? `joué par ${pct(n.share)} des joueurs de ton niveau` : `joué dans ${pct(n.share)} des parties`
  const trap = n.trap ? ` · piège : l’adversaire perd ${((n.oppLoss ?? 0) / 100).toFixed(1)}` : ''
  const transpo = n.transposeTo ? ` · transpose dans ${lineText(n.transposeTo)}` : ''
  return `${n.san} — ${who}${games} · atteinte ${(reach * 100).toFixed(1)} %${trap}${transpo}`
}

export function TreeGraph({ root, reach, selectedId, cursorId, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)

  // Avec les Blancs, le tronc est mon premier coup ; avec les Noirs, un point de départ commun.
  const base = root.children.length === 1 ? root.children[0] : root
  const placed = place(base, { col: 0 })
  const all = flatten(placed)
  const cols = Math.max(1, ...all.map((p) => p.x + 1))
  const maxPly = Math.max(...all.map((p) => p.node.ply))
  const width = cols * COL + 2 * PAD
  const height = (maxPly - base.ply) * ROW + 2 * PAD
  const cx = (p: Placed) => PAD + p.x * COL + COL / 2
  const cy = (p: Placed) => height - PAD - (p.node.ply - base.ply) * ROW

  // Garde la position de travail en vue quand elle change.
  const cursor = all.find((p) => p.node.id === cursorId) ?? placed
  const tx = cx(cursor) * zoom
  const ty = cy(cursor) * zoom
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTo({ left: tx - el.clientWidth / 2, top: ty - el.clientHeight / 2, behavior: 'smooth' })
  }, [tx, ty])

  if (root.children.length === 0) return <p className="muted">L’arbre est vide : joue ton premier coup.</p>

  return (
    <div className="tree-graph">
      <div className="zoom">
        <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} aria-label="Dézoomer">
          −
        </button>
        <button onClick={() => setZoom((z) => Math.min(1.6, z + 0.2))} aria-label="Zoomer">
          +
        </button>
      </div>
      <div className="tree-scroll" ref={box}>
        <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`}>
          {all.map((p) => {
            if (p.children.length === 0) return null
            const top = cy(p) - ROW / 2
            const xs = p.children.map(cx)
            let d = `M${cx(p)} ${cy(p)} V${top} M${Math.min(...xs)} ${top} H${Math.max(...xs)}`
            for (const c of p.children) d += ` M${cx(c)} ${top} V${cy(c)}`
            return <path key={`e-${p.node.id}`} d={d} className="edge" />
          })}
          {all.map((p) => {
            const n = p.node
            if (!n.san) {
              return <circle key="root" cx={cx(p)} cy={cy(p)} r={7} className="root-dot" />
            }
            return (
              <g
                key={n.id}
                transform={`translate(${cx(p)} ${cy(p)})`}
                className={`node ${n.mover} ${n.trap ? 'trap' : ''} ${n.transposeTo ? 'transpo' : ''} ${n.id === selectedId ? 'selected' : ''}`}
                onClick={() => onSelect(n.id)}
              >
                <title>{tooltip(n, reach.get(n.id) ?? 0)}</title>
                {n.id === cursorId && <circle r={R + 6} className="ring" />}
                <circle r={R} className="dot" />
                <text y={-4} className="san" fontSize={n.san.length > 5 ? 10.5 : 13}>
                  <Label san={n.san} />
                </text>
                <text y={10} className="pct">
                  {pct(n.share)}
                </text>
                {n.trap && (
                  <text x={R - 2} y={-R + 4} className="flag">
                    ⚑
                  </text>
                )}
                {n.transposeTo && (
                  <text y={-R - 10} className="transpo-mark">
                    ↪
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
