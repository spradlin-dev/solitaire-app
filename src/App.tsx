import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { TableCanvas } from './ui/TableCanvas.tsx'
import { WinFireworks } from './ui/WinFireworks.tsx'
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
import { positionKey } from './engine/solver.ts'
import { isDrawCount } from './engine/klondike.ts'
import type { DrawCount, KlondikeAction } from './engine/klondike.ts'
import type { SolverWorkerReply } from './solverWorker.ts'

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
    resigned: snapshot.resigned,
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuView, setMenuView] = useState<'actions' | 'stats'>('actions')
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [lost, setLost] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [solving, setSolving] = useState(false)
  const solverRef = useRef<Worker | null>(null)
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

  // The clock runs only while the player can actually act on the board:
  // tab visible, window focused, pause menu closed. pause/resume are
  // idempotent and arming respects the store's paused flag, so
  // re-evaluating the whole predicate on every event is safe regardless
  // of how the events interleave with the first move or hint.
  useEffect(() => {
    const sync = () => {
      if (document.hidden || !document.hasFocus() || menuOpen) store.pause()
      else store.resume()
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [menuOpen])

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

  const newGame = (drawCount: DrawCount) => {
    stopFinishing()
    stopSolving()
    setLost(false)
    setClock(0)
    store.start(randomSeed(), { drawCount })
  }

  const onHint = () => {
    // Asking for a hint is intent: the clock starts even if the answer
    // turns out to be "game over".
    store.startClock()
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
    stopSolving()
    setLost(false)
    setClock(0)
    store.restart()
  }

  // The shared timed-apply loop: auto-finish and solver playback both run
  // through it (input latch, generation counter, one action per beat).
  const playActions = (actions: readonly KlondikeAction[]) => {
    // The menu must not sit over scripted play: the toolbar stays live
    // beneath it, and a menu action landing mid-script (the audit's
    // resign-during-auto-finish find) is exactly the trap.
    setMenuOpen(false)
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

  const onAutoFinish = () => playActions(autoFinishActions(store.getSnapshot().state))

  const stopSolving = () => {
    solverRef.current?.terminate()
    solverRef.current = null
    setSolving(false)
  }

  // Solve resigns first (DESIGN.md section 12), then searches off the
  // main thread. Two guards on every reply: worker identity (only the
  // current search may act — a terminated worker's queued message can
  // still arrive) and the position stamp (the player moved mid-search
  // means the result is dropped).
  const onSolve = () => {
    setMenuOpen(false)
    store.resign()
    stopSolving()
    const submitted = store.getSnapshot().state
    const worker = new Worker(new URL('./solverWorker.ts', import.meta.url), { type: 'module' })
    solverRef.current = worker
    setSolving(true)
    showToast('Solving…')
    worker.onmessage = (event: MessageEvent<SolverWorkerReply>) => {
      if (solverRef.current !== worker) {
        worker.terminate()
        return
      }
      stopSolving()
      const reply = event.data
      if (reply.key !== positionKey(store.getSnapshot().state)) return
      if (reply.outcome === 'won') {
        playActions(reply.line)
      } else if (reply.outcome === 'unwinnable') {
        setLost(true)
      } else {
        showToast('The solver could not decide within its budget.')
      }
    }
    worker.onerror = () => {
      if (solverRef.current !== worker) {
        worker.terminate()
        return
      }
      stopSolving()
      showToast('The solver hit an error.')
    }
    worker.postMessage({ state: submitted })
  }

  // A worker left searching an abandoned page would burn CPU with nobody
  // listening.
  useEffect(() => () => solverRef.current?.terminate(), [])

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

  const setDrawMode = (drawCount: DrawCount) => {
    setSettings({ drawCount })
    saveSettings(storage, { drawCount })
  }

  const canFinish = !snapshot.won && !finishing && autoFinishAvailable(snapshot.state)
  // Refresh trigger for an open stats view. The recorded latch flips in
  // place for wins and resignations; the abandon-by-new-deal loss never
  // publishes that transition, but every abandon path also closes the
  // menu, and the menu deps below recompute the memo anyway.
  const dealEnded = snapshot.recorded
  const stats = useMemo(() => {
    void dealEnded
    return menuOpen && menuView === 'stats' ? loadStats(storage) : null
  }, [menuOpen, menuView, dealEnded])

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Solitaire</h1>
        <span className="status">
          {formatTime(clock)} · {snapshot.state.moves} moves · Draw {snapshot.config.drawCount}
        </span>
        <div className="buttons">
          <button onClick={onUndo} disabled={!snapshot.canUndo || finishing}>
            Undo
          </button>
          <button onClick={onHint} disabled={snapshot.won || finishing}>
            Hint
          </button>
          {canFinish && <button onClick={onAutoFinish}>Auto-finish</button>}
          {finishing && <button onClick={stopFinishing}>Stop</button>}
          <button
            onClick={() => {
              setMenuView('actions')
              setMenuOpen(true)
            }}
            disabled={finishing}
          >
            Menu
          </button>
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
              <button onClick={() => newGame(settings.drawCount)}>New game</button>
              <button onClick={() => setLost(false)}>Dismiss</button>
            </div>
          )}
          {solving && <div className="banner info">Solving…</div>}
          {snapshot.won && snapshot.resigned && !finishing && (
            <div className="banner info">
              Solved — this one was resigned.
              <button onClick={() => newGame(settings.drawCount)}>New game</button>
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
        {snapshot.won && !snapshot.resigned && <WinFireworks />}
        {snapshot.won && !snapshot.resigned && (
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
        {menuOpen && (
          <div className="overlay">
            <div className="dialog menu">
              {menuView === 'actions' ? (
                <>
                  <h2>Paused</h2>
                  <button onClick={() => setMenuOpen(false)}>Resume</button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      newGame(settings.drawCount)
                    }}
                  >
                    New game
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onRestart()
                    }}
                    disabled={!snapshot.canUndo}
                  >
                    Restart deal
                  </button>
                  <button onClick={onShare}>Share deal</button>
                  <button onClick={() => setMenuView('stats')}>Stats</button>
                  {typeof Worker !== 'undefined' && (
                    <button onClick={onSolve} disabled={snapshot.won || solving || finishing}>
                      Solve
                    </button>
                  )}
                  <label className="mode">
                    Next deal:
                    <select
                      value={settings.drawCount}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setDrawMode(isDrawCount(value) ? value : 3)
                      }}
                    >
                      <option value={3}>Draw 3</option>
                      <option value={1}>Draw 1</option>
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <h2>Statistics</h2>
                  {stats !== null && (
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
                  )}
                  <button onClick={() => setMenuView('actions')}>Back</button>
                </>
              )}
            </div>
          </div>
        )}
        {toast !== null && <div className="toast">{toast.message}</div>}
      </main>
    </div>
  )
}
