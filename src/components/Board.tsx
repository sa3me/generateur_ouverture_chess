import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { useEffect, useRef } from 'react'
import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'

interface Props {
  fen: string
  orientation: 'white' | 'black'
  lastMove: string | null
  arrows: DrawShape[]
  /** Si présent, le camp au trait peut jouer, mais seulement ces coups (uci). */
  playable?: string[]
  onMove?: (uci: string) => void
}

export function Board({ fen, orientation, lastMove, arrows, playable, onMove }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const api = useRef<Api | null>(null)
  const moves = useRef<{ playable?: string[]; onMove?: (uci: string) => void }>({})

  useEffect(() => {
    moves.current = { playable, onMove }
  })

  useEffect(() => {
    api.current = Chessground(el.current!, {
      coordinates: true,
      premovable: { enabled: false },
      movable: {
        free: false,
        showDests: true,
        events: {
          after: (orig, dest) => {
            const uci = moves.current.playable?.find((u) => u.startsWith(orig + dest))
            if (uci) moves.current.onMove?.(uci)
          },
        },
      },
    })
    return () => api.current?.destroy()
  }, [])

  useEffect(() => {
    const turnColor = fen.split(' ')[1] === 'w' ? 'white' : 'black'
    const dests = new Map<Key, Key[]>()
    for (const uci of playable ?? []) {
      const from = uci.slice(0, 2) as Key
      dests.set(from, [...(dests.get(from) ?? []), uci.slice(2, 4) as Key])
    }
    api.current?.set({
      fen,
      orientation,
      turnColor,
      lastMove: lastMove ? [lastMove.slice(0, 2) as Key, lastMove.slice(2, 4) as Key] : undefined,
      movable: { color: playable ? turnColor : undefined, dests },
      drawable: { autoShapes: arrows },
    })
  }, [fen, orientation, lastMove, arrows, playable])

  return (
    <div className="board">
      <div ref={el} className="board-inner" />
    </div>
  )
}
