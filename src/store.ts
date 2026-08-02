import { advance, initialState, isWon } from './engine/klondike.ts'
import type { AdvanceResult, KlondikeAction, KlondikeConfig, KlondikeState } from './engine/klondike.ts'

// Single source of truth is the action log: the current game is
// { seed, config, actionLog } and every state is derived by replay through
// advance. The in-memory state stack is only an O(1)-undo cache — it is
// rebuilt from the log on hydrate, so undo depth survives reloads
// (DESIGN.md section 5.2).

export interface DealResult {
  readonly outcome: 'win' | 'loss'
  readonly drawCount: 1 | 3
  readonly timeMs: number
  readonly moves: number
}

export interface GameSnapshot {
  readonly state: KlondikeState
  readonly seed: number
  readonly config: KlondikeConfig
  readonly actionLog: readonly KlondikeAction[]
  readonly canUndo: boolean
  readonly played: boolean
  readonly recorded: boolean
  readonly won: boolean
  readonly elapsedMs: number
}

export interface HydrateInput {
  readonly seed: number
  readonly config: KlondikeConfig
  readonly actionLog: readonly KlondikeAction[]
  readonly elapsedMs: number
  readonly played: boolean
  readonly recorded: boolean
}

export interface GameStoreOptions {
  readonly onDealEnd?: (result: DealResult) => void
  readonly now?: () => number
  // Test seam: real deals cannot be steered into winnable endgames without
  // a solver, so tests inject crafted positions here. Production always
  // uses the engine's initialState.
  readonly deal?: (seed: number, config: KlondikeConfig) => KlondikeState
}

export interface GameStore {
  start(seed: number, config: KlondikeConfig): void
  apply(action: KlondikeAction): AdvanceResult
  undo(): boolean
  restart(): void
  hydrate(saved: HydrateInput): boolean
  pause(): void
  resume(): void
  getElapsedMs(): number
  getSnapshot(): GameSnapshot
  subscribe(listener: () => void): () => void
}

interface GameSession {
  seed: number
  actionLog: KlondikeAction[]
  states: KlondikeState[]
  played: boolean
  recorded: boolean
  elapsedBaseMs: number
  runningSince: number | null
}

export function createGameStore(options: GameStoreOptions = {}): GameStore {
  const now = options.now ?? Date.now
  const deal = options.deal ?? initialState
  const listeners = new Set<() => void>()
  let session: GameSession | null = null
  let snapshot: GameSnapshot | null = null

  function mustSession(): GameSession {
    if (session === null) throw new Error('no game in progress; call start or hydrate first')
    return session
  }

  function elapsedMs(current: GameSession): number {
    if (current.runningSince === null) return current.elapsedBaseMs
    // Clamped because Date.now is not monotonic: a backwards clock step
    // must not shrink elapsed time, go negative, or poison best-time.
    return current.elapsedBaseMs + Math.max(0, now() - current.runningSince)
  }

  function currentState(current: GameSession): KlondikeState {
    return current.states[current.states.length - 1]
  }

  function refresh(): void {
    const current = mustSession()
    const state = currentState(current)
    snapshot = {
      state,
      seed: current.seed,
      // The engine state carries the config; the store keeps no second copy.
      config: state.config,
      // Copied so an already-handed-out snapshot cannot change underneath
      // its holder when the live log is pushed or popped.
      actionLog: [...current.actionLog],
      canUndo: current.actionLog.length > 0,
      played: current.played,
      recorded: current.recorded,
      won: isWon(state),
      elapsedMs: elapsedMs(current),
    }
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        // One broken subscriber must not starve the rest or turn a
        // successful action into a thrown error.
        console.warn('a game store subscriber threw', error)
      }
    }
  }

  // A deal is played once its first action lands; the flag is sticky, so
  // undoing back to move zero cannot erase it. Each played deal produces
  // exactly one record: a win the moment isWon becomes true, or a loss
  // when a new deal replaces it first. The recorded latch is persisted
  // with the save so a win that was undone and reloaded cannot record
  // twice.
  function recordIfDealEnds(current: GameSession, outcome: 'win' | 'loss'): void {
    if (!current.played || current.recorded) return
    current.recorded = true
    options.onDealEnd?.({
      outcome,
      drawCount: currentState(current).config.drawCount,
      timeMs: elapsedMs(current),
      moves: currentState(current).moves,
    })
  }

  return {
    start(seed, config) {
      if (session !== null) recordIfDealEnds(session, 'loss')
      session = {
        seed,
        actionLog: [],
        states: [deal(seed, config)],
        played: false,
        recorded: false,
        elapsedBaseMs: 0,
        runningSince: now(),
      }
      refresh()
    },

    apply(action) {
      const current = mustSession()
      const result = advance(currentState(current), action)
      if (!result.ok) return result
      current.actionLog.push(action)
      current.states.push(result.state)
      current.played = true
      if (isWon(result.state)) recordIfDealEnds(current, 'win')
      refresh()
      return result
    },

    undo() {
      const current = mustSession()
      if (current.actionLog.length === 0) return false
      current.actionLog.pop()
      current.states.pop()
      refresh()
      return true
    },

    // A fresh attempt at the SAME deal: board, move count, and clock all
    // reset. No record is written (the deal has not ended) and the sticky
    // played/recorded latches survive — resetting them would let a restart
    // erase a played deal from the stats. The undo history is gone with
    // the log, so a restart itself cannot be undone.
    restart() {
      const current = mustSession()
      if (current.actionLog.length === 0) return
      current.actionLog = []
      current.states = [current.states[0]]
      current.elapsedBaseMs = 0
      current.runningSince = now()
      refresh()
    },

    hydrate(saved) {
      const states = [deal(saved.seed, saved.config)]
      for (const action of saved.actionLog) {
        const result = advance(states[states.length - 1], action)
        if (!result.ok) {
          // Breadcrumb for the discarded-save path: a genuine engine bug
          // must be distinguishable from ordinary data corruption.
          console.warn('could not replay the saved game', result.reason, action)
          return false
        }
        states.push(result.state)
      }
      // The replaced session's deal still gets its one record, exactly as
      // in start().
      if (session !== null) recordIfDealEnds(session, 'loss')
      session = {
        seed: saved.seed,
        actionLog: [...saved.actionLog],
        states,
        played: saved.played,
        // Reconciled with the replayed position: a corrupted save must not
        // resurrect an already-won game as unrecorded, or its win would be
        // mis-recorded as a loss when the next deal starts.
        recorded: saved.recorded || isWon(states[states.length - 1]),
        elapsedBaseMs: saved.elapsedMs,
        runningSince: now(),
      }
      refresh()
      return true
    },

    pause() {
      const current = mustSession()
      if (current.runningSince === null) return
      current.elapsedBaseMs += Math.max(0, now() - current.runningSince)
      current.runningSince = null
      refresh()
    },

    resume() {
      const current = mustSession()
      if (current.runningSince !== null) return
      current.runningSince = now()
      refresh()
    },

    // Live reading: the snapshot's elapsedMs is frozen at the last change,
    // which would freeze a UI timer between moves.
    getElapsedMs() {
      return elapsedMs(mustSession())
    },

    getSnapshot() {
      if (snapshot === null) throw new Error('no game in progress; call start or hydrate first')
      return snapshot
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
