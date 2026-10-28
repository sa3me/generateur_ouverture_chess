// Stockfish (WASM, mono-thread) dans un Web Worker, piloté en UCI.

export interface PvLine {
  uci: string
  /** Score en centipions du point de vue du camp au trait (les mats sont ramenés à ±10000). */
  cp: number
}

const MATE = 10_000

export class Engine {
  private worker: Worker
  private queue: Promise<unknown>

  constructor() {
    this.worker = new Worker(`${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`)
    this.queue = this.waitFor('uciok', 'uci').then(() => this.waitFor('readyok', 'isready'))
  }

  /** Analyse une position et renvoie jusqu'à `multiPv` lignes, de la meilleure à la moins bonne. */
  analyze(fen: string, multiPv: number, depth: number): Promise<PvLine[]> {
    const job = this.queue.then(() => this.run(fen, multiPv, depth))
    this.queue = job.catch(() => undefined)
    return job
  }

  terminate() {
    this.worker.terminate()
  }

  private waitFor(token: string, command: string): Promise<void> {
    return new Promise((resolve) => {
      const onMessage = (e: MessageEvent) => {
        if (String(e.data).startsWith(token)) {
          this.worker.removeEventListener('message', onMessage)
          resolve()
        }
      }
      this.worker.addEventListener('message', onMessage)
      this.worker.postMessage(command)
    })
  }

  private run(fen: string, multiPv: number, depth: number): Promise<PvLine[]> {
    return new Promise((resolve) => {
      const lines = new Map<number, PvLine>()
      const onMessage = (e: MessageEvent) => {
        const line = String(e.data)
        if (line.startsWith('info') && line.includes(' pv ')) {
          const idx = Number(/ multipv (\d+)/.exec(line)?.[1] ?? 1)
          const score = / score (cp|mate) (-?\d+)/.exec(line)
          const move = / pv (\S+)/.exec(line)?.[1]
          if (!score || !move) return
          const n = Number(score[2])
          const cp = score[1] === 'cp' ? n : n > 0 ? MATE - n : -MATE - n
          lines.set(idx, { uci: move, cp })
        } else if (line.startsWith('bestmove')) {
          this.worker.removeEventListener('message', onMessage)
          resolve([...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l))
        }
      }
      this.worker.addEventListener('message', onMessage)
      this.worker.postMessage('ucinewgame')
      this.worker.postMessage(`setoption name MultiPV value ${multiPv}`)
      this.worker.postMessage(`position fen ${fen}`)
      this.worker.postMessage(`go depth ${depth}`)
    })
  }
}
