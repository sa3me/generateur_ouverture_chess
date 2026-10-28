import type { RepNode } from '../lib/types'

interface Props {
  root: RepNode
  /** Probabilité d'atteindre chaque nœud, transpositions comprises. */
  reach: Map<string, number>
  selectedId: string
  /** La position de travail, mise en évidence. */
  cursorId: string
  onSelect: (id: string) => void
}

function label(node: RepNode, first: boolean): string {
  if (node.ply % 2 === 1) return `${(node.ply + 1) / 2}. ${node.san}`
  return first ? `${node.ply / 2}… ${node.san}` : node.san!
}

/** Une branche : une suite de coups sans embranchement, puis ses sous-branches en retrait. */
function Branch({ start, reach, selectedId, cursorId, onSelect }: { start: RepNode } & Omit<Props, 'root'>) {
  const chain = [start]
  while (chain.at(-1)!.children.length === 1) chain.push(chain.at(-1)!.children[0])
  const end = chain.at(-1)!
  const startReach = reach.get(start.id) ?? 0

  return (
    <li>
      <div className="branch">
        <span className="reach" title="Probabilité d’atteindre cette branche">
          {(startReach * 100).toFixed(startReach < 0.1 ? 1 : 0)} %
        </span>
        {chain.map((n, i) => (
          <button
            key={n.id}
            className={`move ${n.mover} ${n.id === selectedId ? 'selected' : ''} ${n.id === cursorId ? 'cursor' : ''} ${n.trap ? 'trap' : ''}`}
            onClick={() => onSelect(n.id)}
            title={n.mover === 'opp' ? `${(n.share * 100).toFixed(1)} % des parties` : undefined}
          >
            {label(n, i === 0)}
            {n.trap && <span className="trap-flag"> ⚑</span>}
            {n.transposeTo && <span className="muted"> ↪</span>}
          </button>
        ))}
      </div>
      {end.children.length > 1 && (
        <ul>
          {end.children.map((c) => (
            <Branch key={c.id} start={c} reach={reach} selectedId={selectedId} cursorId={cursorId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function TreeView({ root, reach, selectedId, cursorId, onSelect }: Props) {
  if (root.children.length === 0) return <p className="muted">L’arbre est vide : joue ton premier coup.</p>
  return (
    <ul className="tree">
      {root.children.map((c) => (
        <Branch key={c.id} start={c} reach={reach} selectedId={selectedId} cursorId={cursorId} onSelect={onSelect} />
      ))}
    </ul>
  )
}
