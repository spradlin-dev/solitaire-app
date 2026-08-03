import { expect, test } from 'vitest'
import fc from 'fast-check'
import { createGameStore } from './store.ts'
import type { DealResult, HydrateInput } from './store.ts'
import { advance, initialState, legalActions } from './engine/klondike.ts'
import { WINNING_MOVE, nearWinDeal } from './engine/testState.ts'

function hydrateInput(partial: Partial<HydrateInput> & Pick<HydrateInput, 'seed' | 'config' | 'actionLog'>): HydrateInput {
  return { elapsedMs: 0, played: true, recorded: false, ...partial }
}

test('the store refuses snapshots and actions before a game exists', () => {
  const store = createGameStore()
  expect(() => store.getSnapshot()).toThrow('no game in progress')
  expect(() => store.apply({ type: 'draw' })).toThrow('no game in progress')
  expect(() => store.getElapsedMs()).toThrow('no game in progress')
})

test('apply advances on legal actions, rejects illegal ones, and tracks canUndo', () => {
  const store = createGameStore()
  store.start(42, { drawCount: 3 })
  expect(store.getSnapshot().canUndo).toBe(false)
  expect(store.apply({ type: 'recycle' }).ok).toBe(false)
  expect(store.getSnapshot().canUndo).toBe(false)
  expect(store.apply({ type: 'draw' }).ok).toBe(true)
  const snapshot = store.getSnapshot()
  expect(snapshot.canUndo).toBe(true)
  expect(snapshot.state.moves).toBe(1)
  expect(snapshot.actionLog).toHaveLength(1)
  expect(snapshot.config).toEqual({ drawCount: 3 })
})

test('undo integrity: the popped state equals a fresh replay of the shortened log', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.constantFrom<1 | 3>(1, 3),
      fc.array(fc.nat(9999), { minLength: 2, maxLength: 30 }),
      (seed, drawCount, picks) => {
        const store = createGameStore()
        store.start(seed, { drawCount })
        for (const pick of picks) {
          const actions = legalActions(store.getSnapshot().state)
          if (actions.length === 0) break
          store.apply(actions[pick % actions.length])
        }
        const before = store.getSnapshot()
        if (!before.canUndo) return
        expect(store.undo()).toBe(true)
        const after = store.getSnapshot()
        expect(after.actionLog).toHaveLength(before.actionLog.length - 1)
        let replayed = initialState(seed, { drawCount })
        for (const action of after.actionLog) {
          const result = advance(replayed, action)
          if (!result.ok) throw new Error('logged action failed to replay')
          replayed = result.state
        }
        expect(after.state).toEqual(replayed)
      },
    ),
    { numRuns: 25 },
  )
})

test('restart replays the same deal from move zero without ending it', () => {
  let t = 1000
  const results: DealResult[] = []
  const store = createGameStore({ now: () => t, onDealEnd: (result) => results.push(result) })
  store.start(42, { drawCount: 3 })
  const fresh = store.getSnapshot().state
  store.apply({ type: 'draw' })
  store.apply({ type: 'draw' })
  t = 45_000
  store.restart()
  const snapshot = store.getSnapshot()
  expect(snapshot.state).toEqual(fresh)
  expect(snapshot.state.moves).toBe(0)
  expect(snapshot.canUndo).toBe(false)
  expect(snapshot.played).toBe(true)
  expect(snapshot.seed).toBe(42)
  // A fresh attempt gets a fresh clock.
  expect(store.getElapsedMs()).toBe(0)
  expect(results).toHaveLength(0)
  // Restarting an untouched deal is a no-op; abandoning the restarted
  // deal still records its one loss.
  store.restart()
  store.start(2, { drawCount: 3 })
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ outcome: 'loss' })
})

test('undo can cross back to move zero but never clears the played flag', () => {
  const store = createGameStore()
  store.start(42, { drawCount: 3 })
  expect(store.getSnapshot().played).toBe(false)
  store.apply({ type: 'draw' })
  expect(store.getSnapshot().played).toBe(true)
  expect(store.undo()).toBe(true)
  const snapshot = store.getSnapshot()
  expect(snapshot.actionLog).toHaveLength(0)
  expect(snapshot.canUndo).toBe(false)
  expect(snapshot.played).toBe(true)
  expect(store.undo()).toBe(false)
})

test('winning records exactly one result, even after undoing and re-winning', () => {
  const results: DealResult[] = []
  const store = createGameStore({ deal: nearWinDeal, onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 3 })
  expect(store.getSnapshot().recorded).toBe(false)
  expect(store.apply(WINNING_MOVE).ok).toBe(true)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ outcome: 'win', drawCount: 3, moves: 1 })
  expect(store.getSnapshot().recorded).toBe(true)
  store.undo()
  expect(store.apply(WINNING_MOVE).ok).toBe(true)
  expect(results).toHaveLength(1)
  // A recorded deal produces no loss record when abandoned.
  store.start(2, { drawCount: 3 })
  expect(results).toHaveLength(1)
})

test('the recorded latch survives a reload: win, undo, save, hydrate, re-win records once', () => {
  const results: DealResult[] = []
  const source = createGameStore({ deal: nearWinDeal, onDealEnd: (result) => results.push(result) })
  source.start(1, { drawCount: 3 })
  source.apply(WINNING_MOVE)
  source.undo()
  const saved = source.getSnapshot()
  expect(saved.recorded).toBe(true)
  expect(saved.won).toBe(false)

  const restored = createGameStore({ deal: nearWinDeal, onDealEnd: (result) => results.push(result) })
  expect(
    restored.hydrate(
      hydrateInput({ seed: 1, config: saved.config, actionLog: saved.actionLog, recorded: saved.recorded }),
    ),
  ).toBe(true)
  expect(restored.apply(WINNING_MOVE).ok).toBe(true)
  expect(results).toHaveLength(1)
})

test('a corrupted save claiming an unrecorded win cannot mis-record it as a loss', () => {
  const results: DealResult[] = []
  const source = createGameStore({ deal: nearWinDeal })
  source.start(1, { drawCount: 3 })
  source.apply(WINNING_MOVE)
  const saved = source.getSnapshot()

  const store = createGameStore({ deal: nearWinDeal, onDealEnd: (result) => results.push(result) })
  // recorded: false lies about this already-won log; hydrate reconciles.
  expect(
    store.hydrate(
      hydrateInput({ seed: 1, config: saved.config, actionLog: saved.actionLog, recorded: false }),
    ),
  ).toBe(true)
  expect(store.getSnapshot().recorded).toBe(true)
  store.start(2, { drawCount: 3 })
  expect(results).toHaveLength(0)
})

test('abandoning a played deal records a loss; an untouched deal records nothing', () => {
  const results: DealResult[] = []
  const store = createGameStore({ onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 1 })
  store.start(2, { drawCount: 1 })
  expect(results).toHaveLength(0)
  store.apply({ type: 'draw' })
  store.undo()
  store.start(3, { drawCount: 1 })
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ outcome: 'loss', drawCount: 1 })
})

test('hydrating over a played deal records its loss, exactly like start', () => {
  const results: DealResult[] = []
  const store = createGameStore({ onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 1 })
  store.apply({ type: 'draw' })
  expect(
    store.hydrate(hydrateInput({ seed: 2, config: { drawCount: 3 }, actionLog: [], played: false })),
  ).toBe(true)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ outcome: 'loss', drawCount: 1 })
})

test('the reload flow records the loss: hydrate a played save, then start a new deal', () => {
  const results: DealResult[] = []
  const store = createGameStore({ onDealEnd: (result) => results.push(result) })
  expect(
    store.hydrate(
      hydrateInput({ seed: 42, config: { drawCount: 3 }, actionLog: [{ type: 'draw' }], played: true }),
    ),
  ).toBe(true)
  store.start(2, { drawCount: 3 })
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ outcome: 'loss', drawCount: 3 })
})

test('elapsed time accumulates across pause and resume, and stamps the win', () => {
  let t = 1000
  const results: DealResult[] = []
  const store = createGameStore({ deal: nearWinDeal, now: () => t, onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 3 })
  store.startClock()
  t = 1500
  store.pause()
  expect(store.getSnapshot().elapsedMs).toBe(500)
  t = 2000
  store.resume()
  t = 2600
  store.apply(WINNING_MOVE)
  expect(results[0].timeMs).toBe(1100)
})

test('a backwards clock step cannot shrink elapsed time or record a negative win time', () => {
  let t = 10_000
  const results: DealResult[] = []
  const store = createGameStore({ deal: nearWinDeal, now: () => t, onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 3 })
  store.startClock()
  t = 5_000
  store.pause()
  expect(store.getSnapshot().elapsedMs).toBe(0)
  store.resume()
  t = 5_400
  store.apply(WINNING_MOVE)
  expect(results[0].timeMs).toBe(400)
})

test('getElapsedMs reads live without mutating the store', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  store.startClock()
  const snapshotBefore = store.getSnapshot()
  t = 1500
  expect(store.getElapsedMs()).toBe(500)
  // The frozen snapshot is untouched and no notification fired.
  expect(store.getSnapshot()).toBe(snapshotBefore)
})

test('the clock waits for intent: resume cannot start it, the first action does', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  // The visibility sync calls resume on every focus event; before intent
  // it must not start the clock.
  store.resume()
  t = 5000
  expect(store.getElapsedMs()).toBe(0)
  store.apply({ type: 'draw' })
  t = 7000
  expect(store.getElapsedMs()).toBe(2000)
})

test('a hint request arms the clock exactly once', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  store.startClock()
  t = 1400
  expect(store.getElapsedMs()).toBe(400)
  // A second hint must not reset the running clock.
  store.startClock()
  t = 1900
  expect(store.getElapsedMs()).toBe(900)
})

test('restart waits for fresh intent before the clock runs again', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  store.apply({ type: 'draw' })
  t = 3000
  store.restart()
  expect(store.getElapsedMs()).toBe(0)
  store.resume()
  t = 9000
  expect(store.getElapsedMs()).toBe(0)
  store.apply({ type: 'draw' })
  t = 9500
  expect(store.getElapsedMs()).toBe(500)
})

test('a restarted deal reloads with the clock still waiting for intent', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  store.apply({ type: 'draw' })
  t = 3000
  store.restart()
  // What the save subscriber would persist right after the restart: the
  // sticky played latch survives with an empty log and zero elapsed.
  const restored = createGameStore({ now: () => t })
  expect(
    restored.hydrate(hydrateInput({ seed: 42, config: { drawCount: 3 }, actionLog: [], played: true, elapsedMs: 0 })),
  ).toBe(true)
  restored.resume()
  t = 9000
  expect(restored.getElapsedMs()).toBe(0)
  restored.apply({ type: 'draw' })
  t = 9400
  expect(restored.getElapsedMs()).toBe(400)
})

test('a save with accumulated time but no moves hydrates with the clock running', () => {
  // The hint-armed-then-closed shape: no actions yet, but time was spent.
  let t = 1000
  const store = createGameStore({ now: () => t })
  expect(
    store.hydrate(hydrateInput({ seed: 42, config: { drawCount: 3 }, actionLog: [], played: false, elapsedMs: 5000 })),
  ).toBe(true)
  t = 1600
  expect(store.getElapsedMs()).toBe(5600)
})

test('intent while paused arms the clock without running it', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  // The pause menu is open when the player asks for a hint.
  store.pause()
  store.startClock()
  t = 4000
  expect(store.getElapsedMs()).toBe(0)
  store.resume()
  t = 4900
  expect(store.getElapsedMs()).toBe(900)
})

test('a rejected action is not intent: the clock stays at zero', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  store.start(42, { drawCount: 3 })
  expect(store.apply({ type: 'recycle' }).ok).toBe(false)
  t = 5000
  expect(store.getElapsedMs()).toBe(0)
})

test('a save from before any intent hydrates with the clock still waiting', () => {
  let t = 1000
  const store = createGameStore({ now: () => t })
  expect(
    store.hydrate(hydrateInput({ seed: 42, config: { drawCount: 3 }, actionLog: [], played: false, elapsedMs: 0 })),
  ).toBe(true)
  store.resume()
  t = 4000
  expect(store.getElapsedMs()).toBe(0)
  store.apply({ type: 'draw' })
  t = 4600
  expect(store.getElapsedMs()).toBe(600)
})

test('hydrate rebuilds the undo stack from the log and keeps the saved config', () => {
  const source = createGameStore()
  source.start(42, { drawCount: 1 })
  for (let i = 0; i < 3; i++) source.apply({ type: 'draw' })
  const saved = source.getSnapshot()

  const restored = createGameStore()
  expect(
    restored.hydrate(
      hydrateInput({ seed: 42, config: saved.config, actionLog: saved.actionLog, elapsedMs: 7000 }),
    ),
  ).toBe(true)
  const snapshot = restored.getSnapshot()
  expect(snapshot.config).toEqual({ drawCount: 1 })
  expect(snapshot.state).toEqual(saved.state)
  expect(snapshot.played).toBe(true)
  expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(7000)
  expect(restored.undo()).toBe(true)
  expect(restored.undo()).toBe(true)
  expect(restored.undo()).toBe(true)
  expect(restored.undo()).toBe(false)
})

test('hydrate rejects a log the engine rejects, or one that is not even actions', () => {
  const store = createGameStore()
  expect(
    store.hydrate(hydrateInput({ seed: 42, config: { drawCount: 3 }, actionLog: [{ type: 'recycle' }] })),
  ).toBe(false)
  expect(
    store.hydrate(
      hydrateInput({
        seed: 42,
        config: { drawCount: 3 },
        // Simulates a corrupted save whose entries are not real actions.
        actionLog: [{ type: 'move' } as never],
      }),
    ),
  ).toBe(false)
  expect(() => store.getSnapshot()).toThrow('no game in progress')
})

test('a rejected hydrate does not disturb the running game', () => {
  const results: DealResult[] = []
  const store = createGameStore({ onDealEnd: (result) => results.push(result) })
  store.start(1, { drawCount: 3 })
  store.apply({ type: 'draw' })
  const before = store.getSnapshot()
  expect(
    store.hydrate(hydrateInput({ seed: 2, config: { drawCount: 3 }, actionLog: [{ type: 'recycle' }] })),
  ).toBe(false)
  expect(store.getSnapshot()).toBe(before)
  expect(results).toHaveLength(0)
})

test('a throwing subscriber neither starves later subscribers nor breaks apply', () => {
  const store = createGameStore()
  let laterNotified = 0
  store.subscribe(() => {
    throw new Error('bad subscriber')
  })
  store.subscribe(() => laterNotified++)
  store.start(42, { drawCount: 3 })
  expect(store.apply({ type: 'draw' }).ok).toBe(true)
  expect(laterNotified).toBe(2)
})

test('subscribers are notified on every change and can unsubscribe', () => {
  const store = createGameStore()
  let notified = 0
  const unsubscribe = store.subscribe(() => notified++)
  store.start(42, { drawCount: 3 })
  store.apply({ type: 'draw' })
  store.undo()
  expect(notified).toBe(3)
  unsubscribe()
  store.apply({ type: 'draw' })
  expect(notified).toBe(3)
})
