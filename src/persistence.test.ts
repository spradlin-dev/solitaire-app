import { expect, test } from 'vitest'
import fc from 'fast-check'
import { ENGINE_VERSION, GAME_KEY, SCHEMA_VERSION, clearGame, loadGame, saveGame } from './persistence.ts'
import { STATS_KEY } from './stats.ts'
import type { StorageLike } from './storage.ts'
import { fakeStorage } from './testStorage.ts'
import { createGameStore } from './store.ts'
import { legalActions } from './engine/klondike.ts'

function playedGame() {
  const store = createGameStore()
  store.start(42, { drawCount: 3 })
  store.apply({ type: 'draw' })
  store.apply({ type: 'draw' })
  const snapshot = store.getSnapshot()
  return {
    seed: snapshot.seed,
    config: snapshot.config,
    actionLog: snapshot.actionLog,
    elapsedMs: 9000,
    played: snapshot.played,
    recorded: snapshot.recorded,
    resigned: snapshot.resigned,
  }
}

test('a pre-solver save without the resigned field loads as not-resigned', () => {
  const storage = fakeStorage()
  const legacy = JSON.parse(validBlob({ played: true, actionLog: [{ type: 'draw' }] }))
  delete legacy.resigned
  storage.setItem(GAME_KEY, JSON.stringify(legacy))
  const loaded = loadGame(storage)
  expect(loaded).not.toBeNull()
  expect(loaded!.resigned).toBe(false)
})

test('a resigned save round-trips', () => {
  const storage = fakeStorage()
  const game = { ...playedGame(), recorded: true, resigned: true }
  saveGame(storage, game)
  expect(loadGame(storage)).toEqual(game)
})

function validBlob(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    seed: 1,
    config: { drawCount: 3 },
    actionLog: [],
    elapsedMs: 0,
    played: false,
    recorded: false,
    ...overrides,
  })
}

test('a saved game round-trips through load and hydrates to the identical state', () => {
  const storage = fakeStorage()
  const game = playedGame()
  saveGame(storage, game)
  const loaded = loadGame(storage)
  expect(loaded).toEqual(game)

  const original = createGameStore()
  original.start(42, { drawCount: 3 })
  original.apply({ type: 'draw' })
  original.apply({ type: 'draw' })
  const restored = createGameStore()
  expect(restored.hydrate(loaded!)).toBe(true)
  expect(restored.getSnapshot().state).toEqual(original.getSnapshot().state)
})

test('round-trip property: any legally played game survives JSON, including move actions', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.constantFrom<1 | 3>(1, 3),
      fc.array(fc.nat(9999), { minLength: 1, maxLength: 25 }),
      (seed, drawCount, picks) => {
        const store = createGameStore()
        store.start(seed, { drawCount })
        for (const pick of picks) {
          const actions = legalActions(store.getSnapshot().state)
          if (actions.length === 0) break
          // Bias toward moves so Zone objects actually cross the JSON
          // boundary, not just draws.
          const moves = actions.filter((action) => action.type === 'move')
          const pool = moves.length > 0 ? moves : actions
          store.apply(pool[pick % pool.length])
        }
        const snapshot = store.getSnapshot()
        const storage = fakeStorage()
        saveGame(storage, {
          seed,
          config: snapshot.config,
          actionLog: snapshot.actionLog,
          elapsedMs: 1234,
          played: snapshot.played,
          recorded: snapshot.recorded,
          resigned: snapshot.resigned,
        })
        const loaded = loadGame(storage)
        expect(loaded).not.toBeNull()
        const restored = createGameStore()
        expect(restored.hydrate(loaded!)).toBe(true)
        expect(restored.getSnapshot().state).toEqual(snapshot.state)
      },
    ),
    { numRuns: 20 },
  )
})

test('an absent save loads as null without touching storage', () => {
  const storage = fakeStorage()
  expect(loadGame(storage)).toBeNull()
  expect(storage.dump().size).toBe(0)
})

test('damaged saves are discarded and the key removed, leaving other keys alone', () => {
  const cases: string[] = [
    'not json at all',
    '"a string"',
    JSON.stringify({}),
    validBlob({ schemaVersion: SCHEMA_VERSION + 1 }),
    validBlob({ engineVersion: ENGINE_VERSION + 1 }),
    validBlob({ seed: '1' }),
    validBlob({ seed: 4294967296 }),
    validBlob({ config: { drawCount: 2 } }),
    validBlob({ actionLog: {} }),
    validBlob({ elapsedMs: -5 }),
    validBlob({ resigned: 'yes' }),
    validBlob({ resigned: true, played: false }),
    validBlob({ resigned: true, played: true, recorded: false }),
    // A raw overflowing literal: JSON.parse reads this as Infinity.
    validBlob({}).replace('"elapsedMs":0', '"elapsedMs":1e999'),
    validBlob({ played: 'yes' }),
    validBlob({ recorded: 'yes' }),
    // Cross-field lies the real store never produces:
    validBlob({ actionLog: [{ type: 'draw' }], played: false }),
    validBlob({ recorded: true, played: false }),
  ]
  for (const raw of cases) {
    const storage = fakeStorage()
    storage.setItem(GAME_KEY, raw)
    storage.setItem(STATS_KEY, '{"untouched":true}')
    expect(loadGame(storage), raw).toBeNull()
    expect(storage.getItem(GAME_KEY), raw).toBeNull()
    expect(storage.getItem(STATS_KEY)).toBe('{"untouched":true}')
  }
})

test('a shape-valid save whose log the engine rejects is refused by hydrate without crashing', () => {
  const storage = fakeStorage()
  saveGame(storage, {
    seed: 42,
    config: { drawCount: 3 },
    actionLog: [{ type: 'recycle' }],
    elapsedMs: 0,
    played: true,
    recorded: false,
    resigned: false,
  })
  const loaded = loadGame(storage)
  expect(loaded).not.toBeNull()
  const store = createGameStore()
  expect(store.hydrate(loaded!)).toBe(false)
  clearGame(storage)
  expect(storage.getItem(GAME_KEY)).toBeNull()
})

test('a storage that throws is tolerated on every path, including boot', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('storage disabled')
    },
    setItem: () => {
      throw new Error('quota exceeded')
    },
    removeItem: () => {
      throw new Error('storage disabled')
    },
  }
  expect(() => saveGame(throwing, playedGame())).not.toThrow()
  expect(loadGame(throwing)).toBeNull()
  expect(() => clearGame(throwing)).not.toThrow()
})
