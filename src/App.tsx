import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Board } from './components/Board'
import { TreeGraph } from './components/TreeGraph'
import { TreeView } from './components/TreeView'
import { Engine } from './lib/engine'
import { toPgn } from './lib/pgn'
import { collectTraps, countLines, coverage, createRoot, findNode, isMyTurn, lineText, reachById } from './lib/repertoire'
import { Session, type Phase } from './lib/session'
import { DEFAULT_SETTINGS, type RepNode, type Repertoire, type Settings } from './lib/types'

const SETTINGS_KEY = 'verger.settings'
const REP_KEY = 'verger.repertoire.v2'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Stockage indisponible (navigation privée…) : on continue sans.
  }
}

function fmtEval(cp: number | undefined): string {
  if (cp == null) return '—'
  if (Math.abs(cp) > 9000) return `${cp > 0 ? '+' : '−'}M${10_000 - Math.abs(cp)}`
  return `${cp >= 0 ? '+' : '−'}${Math.abs(cp / 100).toFixed(2)}`
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)} %`
const games = (n: number) => `${n.toLocaleString('fr-FR')} partie${n > 1 ? 's' : ''}`

function arrow(uci: string, brush: string): DrawShape {
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush }
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [rep, setRep] = useState<Repertoire | null>(() => {
    const r = load<Repertoire | null>(REP_KEY, null)
    return r?.root ? r : null
  })
  const [, setVersion] = useState(0)
  const [selectedId, setSelectedId] = useState(rep?.cursorId ?? '')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [treeView, setTreeView] = useState<'graph' | 'list'>('graph')
  const engine = useRef<Engine | null>(null)
  const session = useRef<Session | null>(null)

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    const next = { ...settings, [k]: v }
    setSettings(next)
    save(SETTINGS_KEY, next)
  }

  function open(r: Repertoire) {
    engine.current ??= new Engine()
    session.current?.stop()
    // Réglages ajoutés depuis la création du répertoire, et jeton qui a pu changer.
    r.settings = { ...DEFAULT_SETTINGS, ...r.settings, token: settings.token }
    session.current = new Session(r, engine.current, {
      onUpdate: () => setVersion((v) => v + 1),
      onFocus: setSelectedId,
      onPhase: (p) => {
        setPhase(p)
        if (p !== 'busy') save(REP_KEY, r)
      },
      onError: setError,
    })
    setError(null)
    session.current.resume()
  }

  // Au chargement, on reprend le répertoire en cours là où on l'avait laissé.
  useEffect(() => {
    if (rep && !session.current && settings.token) open(rep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function start() {
    if (rep && rep.root.children.length > 0 && !confirm('Commencer un nouveau répertoire ? L’actuel sera effacé.')) return
    const r: Repertoire = { settings: { ...settings }, root: createRoot(), cursorId: '', createdAt: new Date().toISOString() }
    setRep(r)
    setSelectedId('')
    open(r)
  }

  function exportPgn() {
    if (!rep) return
    const blob = new Blob([toPgn(rep)], { type: 'application/x-chess-pgn' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `verger-${rep.settings.color}-${rep.settings.speed}-${rep.settings.elo}.pgn`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // L'arbre est muté en place par la session : tout est recalculé à chaque rendu, que `version` déclenche.
  const reach = rep ? reachById(rep.root) : new Map<string, number>()
  const color = rep?.settings.color ?? settings.color
  const cursorId = rep?.cursorId ?? ''
  const node: RepNode | undefined = rep ? (findNode(rep.root, selectedId) ?? rep.root) : undefined
  const atCursor = node?.id === cursorId
  const choosing = phase === 'choose' && atCursor
  const mine = node ? isMyTurn(node.fen, color) : false

  const arrows: DrawShape[] = !node
    ? []
    : choosing
      ? (node.candidates ?? []).map((c, i) => arrow(c.uci, i === 0 ? 'green' : 'paleBlue'))
      : node.children.map((c) => arrow(c.uci!, c.mover === 'me' ? 'green' : c.trap ? 'red' : 'paleGrey'))

  const lines = rep && rep.root.children.length ? countLines(rep.root) : 0
  const budget = rep?.settings.budget ?? settings.budget
  const maxMoves = rep?.settings.maxMoves ?? settings.maxMoves
  const coverageByMove = rep
    ? Array.from({ length: maxMoves }, (_, i) => ({ move: i + 1, value: coverage(rep.root, 2 * (i + 1), color) }))
    : []
  const traps = rep ? collectTraps(rep.root).slice(0, 8) : []

  return (
    <div className="app">
      <header>
        <h1>Verger</h1>
        <p className="muted">Un répertoire d’ouvertures qui pousse là où tes adversaires jouent vraiment.</p>
      </header>

      <aside className="panel settings">
        <h2>Graine</h2>
        <label>
          Elo
          <input type="number" min={600} max={2800} step={50} value={settings.elo} onChange={(e) => update('elo', Number(e.target.value))} />
        </label>
        <label>
          Couleur
          <select value={settings.color} onChange={(e) => update('color', e.target.value as Settings['color'])}>
            <option value="white">Blancs</option>
            <option value="black">Noirs</option>
          </select>
        </label>
        <label>
          Cadence
          <select value={settings.speed} onChange={(e) => update('speed', e.target.value as Settings['speed'])}>
            <option value="bullet">Bullet</option>
            <option value="blitz">Blitz</option>
            <option value="rapid">Rapide</option>
            <option value="classical">Classique</option>
          </select>
        </label>
        <label>
          Budget de lignes
          <input type="number" min={1} max={200} value={settings.budget} onChange={(e) => update('budget', Number(e.target.value))} />
        </label>
        <label>
          Profondeur (coups)
          <input type="number" min={2} max={25} value={settings.maxMoves} onChange={(e) => update('maxMoves', Number(e.target.value))} />
        </label>

        <details>
          <summary>Réglages fins</summary>
          <label>
            Coups proposés par Stockfish
            <input type="number" min={1} max={8} value={settings.multiPv} onChange={(e) => update('multiPv', Number(e.target.value))} />
          </label>
          <label>
            Perte max. d’un coup proposé (cp)
            <input type="number" min={0} max={300} step={5} value={settings.maxLoss} onChange={(e) => update('maxLoss', Number(e.target.value))} />
          </label>
          <label>
            Parties min. d’un coup adverse
            <input type="number" min={1} max={1000} value={settings.minGames} onChange={(e) => update('minGames', Number(e.target.value))} />
          </label>
          <p className="hint">En dessous, la fréquence n’est pas fiable : le coup n’entre pas dans le répertoire.</p>
          <label>
            Profondeur Stockfish
            <input type="number" min={6} max={24} value={settings.depth} onChange={(e) => update('depth', Number(e.target.value))} />
          </label>
        </details>

        <label>
          Jeton Lichess
          <input type="password" placeholder="lip_…" value={settings.token} onChange={(e) => update('token', e.target.value.trim())} />
        </label>
        <p className="hint">
          L’Opening Explorer exige un jeton personnel, sans permission particulière :{' '}
          <a href="https://lichess.org/account/oauth/token/create?description=Verger" target="_blank" rel="noreferrer">
            en créer un
          </a>
          . Il reste dans ton navigateur.
        </p>

        <div className="actions">
          <button className="primary" onClick={start} disabled={!settings.token || phase === 'busy'}>
            {rep ? 'Nouveau répertoire' : 'Commencer'}
          </button>
          <button onClick={exportPgn} disabled={!rep || lines === 0}>
            Exporter PGN
          </button>
        </div>
        {rep && <p className="hint">Les réglages s’appliquent au prochain répertoire.</p>}
        {error && <p className="error">{error}</p>}
      </aside>

      <main className="center">
        <Board
          fen={node?.fen ?? createRoot().fen}
          orientation={color}
          lastMove={node?.uci ?? null}
          arrows={arrows}
          playable={choosing ? node!.candidates!.map((c) => c.uci) : undefined}
          onMove={(uci) => session.current?.play(uci)}
        />

        {rep && node && (
          <div className="panel work-panel">
            <div className="work-head">
              <h2>{node.id ? node.id.replaceAll('/', ' ') : 'Position initiale'}</h2>
              <span className="muted">
                Ligne {Math.max(lines, 1)} / {budget}
              </span>
            </div>
            <p className="muted">
              {node.games.toLocaleString('fr-FR')} parties à ton niveau · éval {fmtEval(node.evalWhite)} · atteinte{' '}
              {pct(reach.get(node.id) ?? 0)}
              {node.mover === 'opp' && ` · joué dans ${pct(node.share)} des parties`}
              {node.mover === 'opp' && node.moveGames != null && ` (${games(node.moveGames)})`}
              {node.trap && <span className="trap-flag"> · ⚑ piège : l’adversaire perd {((node.oppLoss ?? 0) / 100).toFixed(1)}</span>}
            </p>

            {node.transposeTo && (
              <p className="transpo-note">
                ↪ Cette position est déjà dans ton répertoire, par un autre ordre de coups : <strong>{lineText(node.transposeTo)}</strong>.{' '}
                <button className="link" onClick={() => setSelectedId(node.transposeTo!)}>
                  Aller à cette ligne
                </button>
              </p>
            )}

            {!atCursor ? (
              <div className="actions">
                <button onClick={() => setSelectedId(cursorId)}>Revenir à la position de travail</button>
                {node.mover === 'me' && (
                  <button
                    disabled={phase === 'busy'}
                    onClick={() => {
                      const n = countLines(node)
                      if (n === 1 || confirm(`Remplacer ${node.san} effacera les ${n} lignes qui suivent. Continuer ?`)) {
                        session.current?.replace(node.id)
                      }
                    }}
                  >
                    Remplacer ce coup
                  </button>
                )}
              </div>
            ) : phase === 'busy' ? (
              <p className="status">{mine ? 'Stockfish cherche les meilleurs coups…' : 'L’adversaire choisit son coup le plus fréquent…'}</p>
            ) : phase === 'choose' ? (
              <>
                <p>
                  <strong>À toi de jouer.</strong> Choisis un des coups de Stockfish, sur l’échiquier ou dans la liste.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Coup</th>
                      <th>Éval</th>
                      <th>Perte</th>
                      <th>Joué à ton niveau</th>
                      <th title="Score obtenu avec ce coup par les joueurs de ton niveau (nulle = ½)">Score à ton niveau</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {node.candidates!.map((c, i) => (
                      <tr key={c.uci} className={i === 0 ? 'best' : ''}>
                        <td>{c.san}</td>
                        <td>{fmtEval(c.evalWhite)}</td>
                        <td>{c.loss ? `−${(c.loss / 100).toFixed(2)}` : '—'}</td>
                        <td>{pct(c.share)}</td>
                        <td>
                          {c.score != null && c.games >= rep.settings.minGames ? (
                            <>
                              {pct(c.score)} <span className="muted small">sur {games(c.games)}</span>
                            </>
                          ) : (
                            <span className="muted small" title="Trop peu de parties pour un score fiable">
                              {c.games ? `${games(c.games)} seulement` : 'jamais joué'}
                            </span>
                          )}
                        </td>
                        <td>
                          <button onClick={() => session.current?.play(c.uci)}>Jouer</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : phase === 'done' ? (
              <div className="actions">
                <p>
                  <strong>Répertoire terminé : {lines} lignes.</strong>
                </p>
                <button onClick={() => session.current?.addLines(5)}>+ 5 lignes</button>
              </div>
            ) : (
              <div className="actions">
                <button className="primary" disabled={!settings.token} onClick={() => open(rep)}>
                  Reprendre
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      <section className={`panel tree-panel ${treeView}`}>
        <div className="tree-head">
          <h2>Arbre {lines > 0 && <span className="muted">· {lines} lignes</span>}</h2>
          <div className="toggle">
            <button className={treeView === 'graph' ? 'on' : ''} onClick={() => setTreeView('graph')}>
              Arbre
            </button>
            <button className={treeView === 'list' ? 'on' : ''} onClick={() => setTreeView('list')}>
              Liste
            </button>
          </div>
        </div>
        {treeView === 'graph' && rep && lines > 0 && (
          <p className="legend">
            <span className="swatch me" /> mes coups · <span className="swatch opp" /> coups adverses · % = fréquence à ton niveau
          </p>
        )}
        {rep && treeView === 'graph' ? (
          <TreeGraph root={rep.root} reach={reach} selectedId={node?.id ?? ''} cursorId={cursorId} onSelect={setSelectedId} />
        ) : rep ? (
          <TreeView root={rep.root} reach={reach} selectedId={node?.id ?? ''} cursorId={cursorId} onSelect={setSelectedId} />
        ) : (
          <p className="muted">Règle ta graine, puis clique sur « Commencer ».</p>
        )}
      </section>

      {rep && lines > 0 && (
        <section className="panel insights">
          <div>
            <h2>Couverture</h2>
            <p className="hint">Probabilité de rester dans ton répertoire jusqu’au coup N face à des joueurs de ton niveau.</p>
            <div className="bars">
              {coverageByMove.map(({ move, value }) => (
                <div key={move} className="bar" title={`Coup ${move} : ${pct(value)}`}>
                  <div className="fill" style={{ height: `${value * 100}%` }} />
                  <span>{move}</span>
                </div>
              ))}
            </div>
            {coverageByMove.length >= 8 && (
              <p>
                Ton répertoire couvre <strong>{pct(coverageByMove[7].value)}</strong> des parties jusqu’au coup 8.
              </p>
            )}
          </div>
          <div>
            <h2>Pièges</h2>
            {traps.length === 0 ? (
              <p className="muted">Aucun coup adverse à la fois fréquent et perdant pour l’instant.</p>
            ) : (
              <ul className="traps">
                {traps.map(({ node: t, reach: r }) => (
                  <li key={t.id}>
                    <button className="link" onClick={() => setSelectedId(t.id)}>
                      {t.id.replaceAll('/', ' ')}
                    </button>
                    <span className="muted">
                      {' '}
                      · joué {pct(t.share)} · perd {((t.oppLoss ?? 0) / 100).toFixed(1)} · atteint {pct(r)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
