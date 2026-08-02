import { expect, test } from 'vitest'
import { STATS_KEY, emptyModeStats, loadStats, recordDealEnd } from './stats.ts'
import type { StorageLike } from './storage.ts'
import { fakeStorage } from './testStorage.ts'
import { createGameStore } from './store.ts'
import { WINNING_MOVE, nearWinDeal } from './engine/testState.ts'

const win = (drawCount: 1 | 3, timeMs: number, moves: number) =>
  ({ outcome: 'win', drawCount, timeMs, moves }) as const
const loss = (drawCount: 1 | 3) => ({ outcome: 'loss', drawCount, timeMs: 0, moves: 0 }) as const

test('missing or damaged stats load as empty', () => {
  expect(loadStats(fakeStorage())).toEqual({ draw1: emptyModeStats(), draw3: emptyModeStats() })
  for (const raw of ['garbage', '[]', '{}', '{"draw1":{},"draw3":{}}', JSON.stringify({ draw1: emptyModeStats(), draw3: { ...emptyModeStats(), wins: -1 } })]) {
    const storage = fakeStorage()
    storage.setItem(STATS_KEY, raw)
    expect(loadStats(storage), raw).toEqual({ draw1: emptyModeStats(), draw3: emptyModeStats() })
  }
})

test('wins and losses update streaks, best time, and fewest moves correctly', () => {
  const storage = fakeStorage()
  recordDealEnd(storage, win(3, 60_000, 120))
  recordDealEnd(storage, win(3, 90_000, 100))
  let stats = loadStats(storage).draw3
  expect(stats).toEqual({
    wins: 2,
    losses: 0,
    currentStreak: 2,
    bestStreak: 2,
    bestTimeMs: 60_000,
    fewestMoves: 100,
  })
  recordDealEnd(storage, loss(3))
  stats = loadStats(storage).draw3
  expect(stats.currentStreak).toBe(0)
  expect(stats.bestStreak).toBe(2)
  expect(stats.losses).toBe(1)
  recordDealEnd(storage, win(3, 45_000, 130))
  stats = loadStats(storage).draw3
  expect(stats.currentStreak).toBe(1)
  expect(stats.bestStreak).toBe(2)
  expect(stats.bestTimeMs).toBe(45_000)
  expect(stats.fewestMoves).toBe(100)
})

test('draw 1 and draw 3 buckets are independent', () => {
  const storage = fakeStorage()
  recordDealEnd(storage, win(1, 30_000, 80))
  recordDealEnd(storage, loss(3))
  const stats = loadStats(storage)
  expect(stats.draw1.wins).toBe(1)
  expect(stats.draw1.losses).toBe(0)
  expect(stats.draw3.wins).toBe(0)
  expect(stats.draw3.losses).toBe(1)
})

test('fractional win times are rounded before comparison', () => {
  const storage = fakeStorage()
  recordDealEnd(storage, win(1, 1000.6, 50))
  expect(loadStats(storage).draw1.bestTimeMs).toBe(1001)
})

test('a storage that throws on write still returns the updated stats without throwing', () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded')
    },
    removeItem: () => {},
  }
  const updated = recordDealEnd(throwing, win(3, 30_000, 90))
  expect(updated.draw3.wins).toBe(1)
})

// The wiring the app will use: the store's deal-end hook feeds the stats.
test('a store wired to recordDealEnd writes a win through to storage', () => {
  const storage = fakeStorage()
  const store = createGameStore({ deal: nearWinDeal, onDealEnd: (result) => recordDealEnd(storage, result) })
  store.start(1, { drawCount: 3 })
  store.apply(WINNING_MOVE)
  expect(loadStats(storage).draw3.wins).toBe(1)
})
