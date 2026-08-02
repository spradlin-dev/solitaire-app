import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { TableCanvas } from './ui/TableCanvas.tsx'
import type { TableScene } from './ui/scene.ts'
import type { SceneHandlers } from './ui/scene.ts'
import { createGameStore } from './store.ts'
import { autoFinishActions, autoFinishAvailable, hint, isLossDeclarable, tapAction } from './engine/helpers.ts'
import { clearGame, loadGame, saveGame } from './persistence.ts'
import { loadStats, recordDealEnd } from './stats.ts'
import type { ModeStats } from './stats.ts'
import { loadSettings, saveSettings } from './settings.ts'
import { chooseBoot } from './boot.ts'
import { formatDealFragment } from './dealLink.ts'
import { scheduleSwUpdateChecks } from './pwaUpdate.ts'

// The module-level bootstrap below runs once per page; a hot update would
// re-run it and orphan a live store, so reload outright (same rule as
// scene.ts).
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}

// Top-level bootstrap, gin-style: one store, wired to stats and saves, with
// the boot decision (deal link > saved game > fresh deal) applied once.
const storage = window.localStorage
const store = createGameStore({ onDealEnd: (result) => recordDealEnd(storage, result) })

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

// Saved after every change (DESIGN.md section 5.2). Registered BEFORE the
// boot sequence so a boot that starts a new deal immediately overwrites
// the old blob — leaving it behind would let an already-loss-recorded deal
// resurrect on the next load and record a second loss.
// Durable storage protects a long-lived save from eviction; requested only
// once a deal is actually played, never on a bare visit (DESIGN.md
// section 6). Best-effort: browsers routinely deny until the app is
// installed or trusted, and that is fine.
let persistRequested = false
function requestDurableStorageOnce(played: boolean): void {
  if (!played || persistRequested) return
  persistRequested = true
  navigator.storage?.persist?.().catch(() => {})
}

store.subscribe(() => {
  const snapshot = store.getSnapshot()
  saveGame(storage, {
    seed: snapshot.seed,
    config: snapshot.config,
    actionLog: snapshot.actionLog,
    elapsedMs: store.getElapsedMs(),
    played: snapshot.played,
    recorded: snapshot.recorded,
  })
  requestDurableStorageOnce(snapshot.played)
})

const plan = chooseBoot(window.location.hash, loadGame(storage))
let booted = false
if (plan.hydrate !== null) {
  booted = store.hydrate(plan.hydrate)
  if (!booted) clearGame(storage)
}
if (plan.start !== null) {
  store.start(plan.start.seed, { drawCount: plan.start.drawCount })
  booted = true
}
if (!booted) store.start(randomSeed(), loadSettings(storage))

document.addEventListener('visibilitychange', () => {
  if (document.hidden) store.pause()
  else store.resume()
})

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function StatsRow({ label, stats }: { label: string; stats: ModeStats }) {
  return (
    <tr>
      <th>{label}</th>
      <td>{stats.wins}</td>
      <td>{stats.losses}</td>
      <td>{stats.currentStreak}</td>
      <td>{stats.bestStreak}</td>
      <td>{stats.bestTimeMs === null ? '—' : formatTime(stats.bestTimeMs)}</td>
      <td>{stats.fewestMoves ?? '—'}</td>
    </tr>
  )
}

export default function App() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [settings, setSettings] = useState(() => loadSettings(storage))
  const [statsOpen, setStatsOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [lost, setLost] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [tableBroken, setTableBroken] = useState(false)
  const [clock, setClock] = useState(0)
  const sceneRef = useRef<TableScene | null>(null)
  const toastId = useRef(0)
  // In dev the plugin serves a stub (no worker; these flags never fire) —
  // verify this wiring against a real build via `npm run preview`.
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    // Deferred to the window load event so the full-app precache does not
    // compete with the first paint's own asset fetches.
    immediate: false,
    onRegisteredSW: (_swUrl, registration) => scheduleSwUpdateChecks(registration),
    onRegisterError: (error) => console.error('the service worker failed to register', error),
  })
  // The ref mirrors `finishing` for the scene handlers, which must not be
  // recreated per render; the generation counter cancels a superseded
  // auto-finish chain (a stray timer from an abandoned run must not act).
  const finishingRef = useRef(false)
  const finishRun = useRef(0)

  const showToast = (message: string) => setToast({ id: ++toastId.current, message })

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const timer = setInterval(() => setClock(store.getElapsedMs()), 1000)
    return () => clearInterval(timer)
  }, [])

  // One-time confirmation that the precache finished — after this, the
  // game loads with no network.
  useEffect(() => {
    if (!offlineReady) return
    showToast('Ready to play offline')
    setOfflineReady(false)
  }, [offlineReady, setOfflineReady])

  const handlers = useMemo<SceneHandlers>(
    () => ({
      onAction: (action) => {
        if (finishingRef.current) return false
        return store.apply(action).ok
      },
      onTap: (spot) => {
        if (finishingRef.current) return
        const action = tapAction(store.getSnapshot().state, spot)
        if (action !== null) store.apply(action)
      },
    }),
    [],
  )

  const stopFinishing = () => {
    finishRun.current++
    finishingRef.current = false
    setFinishing(false)
  }

  const newGame = (drawCount: 1 | 3) => {
    stopFinishing()
    setLost(false)
    store.start(randomSeed(), { drawCount })
  }

  const onHint = () => {
    const current = store.getSnapshot()
    // Etiquette, not truth: the loss may be provable earlier, but the
    // player gets one full fruitless pass through the stock first.
    if (isLossDeclarable(current.state, current.actionLog)) {
      setLost(true)
      return
    }
    const suggestion = hint(current.state)
    if (suggestion === null) showToast('No useful move — try undoing or a new deal.')
    else sceneRef.current?.flashHint(suggestion)
  }

  const onUndo = () => {
    setLost(false)
    store.undo()
  }

  const onRestart = () => {
    stopFinishing()
    setLost(false)
    store.restart()
  }

  const onAutoFinish = () => {
    const actions = autoFinishActions(store.getSnapshot().state)
    const run = ++finishRun.current
    finishingRef.current = true
    setFinishing(true)
    let index = 0
    const step = () => {
      if (run !== finishRun.current) return
      if (index >= actions.length) {
        stopFinishing()
        return
      }
      const result = store.apply(actions[index])
      index += 1
      if (!result.ok || index >= actions.length) {
        stopFinishing()
        return
      }
      setTimeout(step, 140)
    }
    step()
  }

  const onShare = () => {
    const link = `${window.location.origin}${window.location.pathname}${formatDealFragment({
      seed: snapshot.seed,
      drawCount: snapshot.config.drawCount,
    })}`
    navigator.clipboard.writeText(link).then(
      () => showToast('Deal link copied'),
      () => showToast('Could not copy the link'),
    )
  }

  const setDrawMode = (drawCount: 1 | 3) => {
    setSettings({ drawCount })
    saveSettings(storage, { drawCount })
  }

  const canFinish = !snapshot.won && !finishing && autoFinishAvailable(snapshot.state)
  // The recorded latch flips exactly when a deal ends, so it is the
  // narrowest refresh trigger for an open stats panel.
  const dealEnded = snapshot.recorded
  const stats = useMemo(() => {
    void dealEnded
    return statsOpen ? loadStats(storage) : null
  }, [statsOpen, dealEnded])

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Solitaire</h1>
        <span className="status">
          {formatTime(clock)} · {snapshot.state.moves} moves · Draw {snapshot.config.drawCount}
        </span>
        <div className="buttons">
          <button onClick={() => newGame(settings.drawCount)} disabled={finishing}>
            New game
          </button>
          <button onClick={onUndo} disabled={!snapshot.canUndo || finishing}>
            Undo
          </button>
          <button onClick={onRestart} disabled={!snapshot.canUndo || finishing}>
            Restart deal
          </button>
          <button onClick={onHint} disabled={snapshot.won || finishing}>
            Hint
          </button>
          {canFinish && <button onClick={onAutoFinish}>Auto-finish</button>}
          <button onClick={onShare}>Share deal</button>
          <button onClick={() => setStatsOpen((open) => !open)}>Stats</button>
          <label className="mode">
            Next deal:
            <select
              value={settings.drawCount}
              onChange={(event) => setDrawMode(Number(event.target.value) === 1 ? 1 : 3)}
            >
              <option value={3}>Draw 3</option>
              <option value={1}>Draw 1</option>
            </select>
          </label>
        </div>
      </header>

      <main className="table-wrap">
        <TableCanvas
          snapshot={snapshot}
          handlers={handlers}
          onSceneReady={(scene) => {
            sceneRef.current = scene
          }}
          onSceneError={(error) => {
            console.error('the table failed to load', error)
            setTableBroken(true)
          }}
        />
        <div className="banner-stack">
          {tableBroken && (
            <div className="banner">
              The table failed to load. Refresh the page to try again — your game is saved.
            </div>
          )}
          {lost && !snapshot.won && (
            <div className="banner">
              Game over — no winning line exists from here. Undo to try another path, or deal again.
              <button onClick={() => setLost(false)}>Dismiss</button>
            </div>
          )}
          {needRefresh && (
            <div className="banner info">
              Update ready — reload to apply. Your game is saved.
              <button onClick={() => updateServiceWorker(true)}>Reload</button>
              <button onClick={() => setNeedRefresh(false)}>Later</button>
            </div>
          )}
        </div>
        {snapshot.won && (
          <div className="overlay">
            <div className="dialog">
              <h2>You won!</h2>
              <p>
                {formatTime(snapshot.elapsedMs)} · {snapshot.state.moves} moves
              </p>
              <button onClick={() => newGame(settings.drawCount)}>New game</button>
            </div>
          </div>
        )}
        {stats !== null && (
          <div className="panel">
            <h2>Statistics</h2>
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Wins</th>
                  <th>Losses</th>
                  <th>Streak</th>
                  <th>Best streak</th>
                  <th>Best time</th>
                  <th>Fewest moves</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Draw 1" stats={stats.draw1} />
                <StatsRow label="Draw 3" stats={stats.draw3} />
              </tbody>
            </table>
            <button onClick={() => setStatsOpen(false)}>Close</button>
          </div>
        )}
        {toast !== null && <div className="toast">{toast.message}</div>}
      </main>
    </div>
  )
}
