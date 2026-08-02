import { expect, test } from 'vitest'
import { chooseBoot } from './boot.ts'
import type { SavedGame } from './persistence.ts'

const SAVED: SavedGame = {
  seed: 7,
  config: { drawCount: 1 },
  actionLog: [{ type: 'draw' }],
  elapsedMs: 100,
  played: true,
  recorded: false,
}

test('a deal link wins, but a saved game is still hydrated first for its loss record', () => {
  expect(chooseBoot('#deal=42.3', SAVED)).toEqual({ hydrate: SAVED, start: { seed: 42, drawCount: 3 } })
  expect(chooseBoot('#deal=42.1', null)).toEqual({ hydrate: null, start: { seed: 42, drawCount: 1 } })
})

test('with no link, a saved game resumes and nothing new starts', () => {
  expect(chooseBoot('', SAVED)).toEqual({ hydrate: SAVED, start: null })
})

test('a link matching the saved deal resumes it instead of restarting', () => {
  // The fragment survives a refresh; restarting would wipe progress and
  // record a false loss.
  expect(chooseBoot('#deal=7.1', SAVED)).toEqual({ hydrate: SAVED, start: null })
  // The same seed in the other draw mode is a different deal.
  expect(chooseBoot('#deal=7.3', SAVED)).toEqual({ hydrate: SAVED, start: { seed: 7, drawCount: 3 } })
})

test('a malformed fragment falls back to a normal boot', () => {
  expect(chooseBoot('#deal=oops', SAVED)).toEqual({ hydrate: SAVED, start: null })
  expect(chooseBoot('#deal=oops', null)).toEqual({ hydrate: null, start: null })
})
