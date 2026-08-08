import { isDrawCount } from './engine/klondike.ts'
import type { DrawCount } from './engine/klondike.ts'
import type { StorageLike } from './storage.ts'

// The draw-mode preference. It applies to the NEXT new deal only — a game
// in progress always replays with the config stored in its save
// (DESIGN.md section 3).

export const SETTINGS_KEY = 'solitaire:settings'

export interface Settings {
  readonly drawCount: DrawCount
}

// New games default to Draw 3 (DESIGN.md section 2).
const DEFAULTS: Settings = { drawCount: 3 }

export function loadSettings(storage: StorageLike): Settings {
  let raw: string | null
  try {
    raw = storage.getItem(SETTINGS_KEY)
  } catch {
    return DEFAULTS
  }
  if (raw === null) return DEFAULTS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULTS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
  const drawCount = (parsed as Record<string, unknown>).drawCount
  return isDrawCount(drawCount) ? { drawCount } : DEFAULTS
}

export function saveSettings(storage: StorageLike, settings: Settings): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch (error) {
    console.warn('could not save settings', error)
  }
}
