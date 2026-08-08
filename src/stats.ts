import type { DealResult } from './store.ts'
import type { StorageLike } from './storage.ts'

// Lifetime stats, bucketed by draw mode and stored separately from game
// saves (DESIGN.md section 5.2). Damaged data resets to empty rather than
// crashing — stats are a comfort feature, not a ledger.

export interface ModeStats {
  readonly wins: number
  readonly losses: number
  readonly currentStreak: number
  readonly bestStreak: number
  readonly bestTimeMs: number | null
  readonly fewestMoves: number | null
}

export interface Stats {
  readonly draw1: ModeStats
  readonly draw3: ModeStats
}

export const STATS_KEY = 'solitaire:stats'

// A lookup rather than a ternary so a widened drawCount union fails to
// compile here instead of silently pooling into one bucket.
const BUCKETS: Record<1 | 3, keyof Stats> = { 1: 'draw1', 3: 'draw3' }

export function emptyModeStats(): ModeStats {
  return { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, bestTimeMs: null, fewestMoves: null }
}

function emptyStats(): Stats {
  return { draw1: emptyModeStats(), draw3: emptyModeStats() }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null || isCount(value)
}

// Per-field defaults instead of whole-blob rejection: a future field
// added to ModeStats must not wipe every returning player's history, and
// one damaged counter costs only itself.
function readModeStats(value: unknown): ModeStats {
  const stats = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    wins: isCount(stats.wins) ? stats.wins : 0,
    losses: isCount(stats.losses) ? stats.losses : 0,
    currentStreak: isCount(stats.currentStreak) ? stats.currentStreak : 0,
    bestStreak: isCount(stats.bestStreak) ? stats.bestStreak : 0,
    bestTimeMs: isCountOrNull(stats.bestTimeMs) ? stats.bestTimeMs : null,
    fewestMoves: isCountOrNull(stats.fewestMoves) ? stats.fewestMoves : null,
  }
}

export function loadStats(storage: StorageLike): Stats {
  // Guarded like every other storage read in the app: a blocked
  // localStorage must never crash the Stats view — or the winning move,
  // which records through here.
  let raw: string | null
  try {
    raw = storage.getItem(STATS_KEY)
  } catch (error) {
    console.warn('could not read stats', error)
    return emptyStats()
  }
  if (raw === null) return emptyStats()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStats()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyStats()
  const stats = parsed as Record<string, unknown>
  return { draw1: readModeStats(stats.draw1), draw3: readModeStats(stats.draw3) }
}

function applyResult(stats: ModeStats, result: DealResult): ModeStats {
  if (result.outcome === 'loss') {
    return { ...stats, losses: stats.losses + 1, currentStreak: 0 }
  }
  const currentStreak = stats.currentStreak + 1
  const timeMs = Math.max(0, Math.round(result.timeMs))
  return {
    ...stats,
    wins: stats.wins + 1,
    currentStreak,
    bestStreak: Math.max(stats.bestStreak, currentStreak),
    bestTimeMs: stats.bestTimeMs === null ? timeMs : Math.min(stats.bestTimeMs, timeMs),
    fewestMoves: stats.fewestMoves === null ? result.moves : Math.min(stats.fewestMoves, result.moves),
  }
}

export function recordDealEnd(storage: StorageLike, result: DealResult): Stats {
  const stats = loadStats(storage)
  const bucket = BUCKETS[result.drawCount]
  const updated: Stats = { ...stats, [bucket]: applyResult(stats[bucket], result) }
  try {
    storage.setItem(STATS_KEY, JSON.stringify(updated))
  } catch (error) {
    console.warn('could not save stats', error)
  }
  return updated
}
