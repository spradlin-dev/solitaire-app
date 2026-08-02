import { MAX_SEED } from './engine/klondike.ts'
import type { KlondikeAction, KlondikeConfig } from './engine/klondike.ts'
import type { StorageLike } from './storage.ts'

// localStorage persistence for the in-progress game (DESIGN.md section 5.2).
// The saved blob is version-stamped; on any mismatch or damage the game is
// discarded gracefully (settings and stats live under other keys) — never
// crash, never guess. Replay validation is the store's job (hydrate); this
// module owns shape and version checks. Every storage call is guarded: a
// blocked or full localStorage must never break the app, especially not on
// the boot path.

export const SCHEMA_VERSION = 1
// Bump when replaying an old log through the current engine would produce
// different states than it did when saved.
export const ENGINE_VERSION = 1

export const GAME_KEY = 'solitaire:game'

export interface SavedGame {
  readonly seed: number
  readonly config: KlondikeConfig
  readonly actionLog: readonly KlondikeAction[]
  readonly elapsedMs: number
  readonly played: boolean
  readonly recorded: boolean
}

export function saveGame(storage: StorageLike, game: SavedGame): void {
  const blob = { schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, ...game }
  try {
    storage.setItem(GAME_KEY, JSON.stringify(blob))
  } catch (error) {
    console.warn('could not save the game', error)
  }
}

export function clearGame(storage: StorageLike): void {
  try {
    storage.removeItem(GAME_KEY)
  } catch (error) {
    console.warn('could not clear the saved game', error)
  }
}

function isValidDrawCount(value: unknown): value is 1 | 3 {
  return value === 1 || value === 3
}

function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SEED
}

export function loadGame(storage: StorageLike): SavedGame | null {
  let raw: string | null
  try {
    raw = storage.getItem(GAME_KEY)
  } catch (error) {
    console.warn('could not read the saved game', error)
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearGame(storage)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    clearGame(storage)
    return null
  }
  const blob = parsed as Record<string, unknown>
  const config = blob.config as Record<string, unknown> | null | undefined
  const valid =
    blob.schemaVersion === SCHEMA_VERSION &&
    blob.engineVersion === ENGINE_VERSION &&
    isSeed(blob.seed) &&
    typeof config === 'object' &&
    config !== null &&
    isValidDrawCount(config.drawCount) &&
    Array.isArray(blob.actionLog) &&
    typeof blob.elapsedMs === 'number' &&
    Number.isFinite(blob.elapsedMs) &&
    blob.elapsedMs >= 0 &&
    typeof blob.played === 'boolean' &&
    typeof blob.recorded === 'boolean' &&
    // Cross-field consistency the real store always maintains: a deal with
    // actions was played, and only a played deal can have been recorded.
    (blob.actionLog.length === 0 || blob.played === true) &&
    (blob.recorded !== true || blob.played === true)
  if (!valid) {
    clearGame(storage)
    return null
  }
  return {
    seed: blob.seed as number,
    config: { drawCount: config.drawCount as 1 | 3 },
    actionLog: blob.actionLog as KlondikeAction[],
    elapsedMs: blob.elapsedMs as number,
    played: blob.played as boolean,
    recorded: blob.recorded as boolean,
  }
}
