import { MAX_SEED, isDrawCount } from './engine/klondike.ts'
import type { DrawCount, KlondikeAction } from './engine/klondike.ts'
import type { HydrateInput } from './store.ts'
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

// The saved blob IS the store's hydrate input — one shape, one owner.
// (The resigned field is absent in saves written before the solver;
// they load as not-resigned rather than being discarded.)
export type SavedGame = HydrateInput

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
    isDrawCount(config.drawCount) &&
    Array.isArray(blob.actionLog) &&
    typeof blob.elapsedMs === 'number' &&
    Number.isFinite(blob.elapsedMs) &&
    blob.elapsedMs >= 0 &&
    typeof blob.played === 'boolean' &&
    typeof blob.recorded === 'boolean' &&
    (blob.resigned === undefined || typeof blob.resigned === 'boolean') &&
    // Cross-field consistency the real store always maintains: a deal with
    // actions was played, only a played deal can have been recorded, and
    // resigning always marks the deal played and recorded.
    (blob.actionLog.length === 0 || blob.played === true) &&
    (blob.recorded !== true || blob.played === true) &&
    (blob.resigned !== true || (blob.played === true && blob.recorded === true))
  if (!valid) {
    clearGame(storage)
    return null
  }
  return {
    seed: blob.seed as number,
    config: { drawCount: config.drawCount as DrawCount },
    actionLog: blob.actionLog as KlondikeAction[],
    elapsedMs: blob.elapsedMs as number,
    played: blob.played as boolean,
    recorded: blob.recorded as boolean,
    resigned: blob.resigned === true,
  }
}
