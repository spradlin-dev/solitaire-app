import { parseDealFragment } from './dealLink.ts'
import type { SavedGame } from './persistence.ts'

// Pure boot decision (DESIGN.md section 5.3): a #deal= fragment starts
// exactly that deal, a saved game resumes, otherwise a fresh deal. When a
// link arrives while a save exists, the save is hydrated FIRST so the
// abandoned deal still gets its one loss record, then the linked deal
// starts on top.

export interface BootPlan {
  readonly hydrate: SavedGame | null
  readonly start: { readonly seed: number; readonly drawCount: 1 | 3 } | null
}

export function chooseBoot(fragment: string, saved: SavedGame | null): BootPlan {
  const link = parseDealFragment(fragment)
  // A link matching the saved game is a reload of that same deal (the
  // fragment survives a refresh): resume it. Restarting would wipe the
  // progress and record a false loss.
  const resuming =
    link !== null && saved !== null && saved.seed === link.seed && saved.config.drawCount === link.drawCount
  return {
    hydrate: saved,
    start: link === null || resuming ? null : { seed: link.seed, drawCount: link.drawCount },
  }
}
