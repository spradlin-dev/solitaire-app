import { expect, test } from 'vitest'
import fc from 'fast-check'
import { positionKey, solve, tightenLine } from './solver.ts'
import { initialState, isWon } from './klondike.ts'
import type { KlondikeAction } from './klondike.ts'
import { isProvablyLost } from './helpers.ts'
import { cards } from './testCards.ts'
import { EMPTY_PILE, fullFoundations, makeState, nearWinDeal, pile, playout, replay, suitPrefix } from './testState.ts'

test('a won position solves to an empty line', () => {
  const won = makeState({ foundations: fullFoundations() })
  expect(solve(won)).toEqual({ outcome: 'won', line: [] })
})

test('the near-win fixture solves, and its line replays to the win', () => {
  const start = nearWinDeal()
  const result = solve(start)
  expect(result.outcome).toBe('won')
  if (result.outcome !== 'won') return
  expect(isWon(replay(start, result.line))).toBe(true)
})

test('known hint-winnable full deals solve to wins that replay', () => {
  for (const seed of [0, 1]) {
    const start = initialState(seed, { drawCount: 1 })
    // An explicit budget so a search regression fails as a clean
    // undecided-is-not-won assertion instead of a multi-second timeout.
    const result = solve(start, { maxNodes: 200_000, maxVisited: 200_000 })
    expect(result.outcome).toBe('won')
    if (result.outcome !== 'won') continue
    expect(isWon(replay(start, result.line))).toBe(true)
  }
})

test('dead positions return unwinnable, with and without pruning', () => {
  // Both fixtures are the section 4 loss-detection shapes, verified lost
  // by isProvablyLost inline — the sound oracle: section-4-lost is a
  // subset of unwinnable.
  const noActions = makeState({
    tableau: [
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
    ],
  })
  // The ace's pull onto the 2 of spades is LEGAL but pointless — this
  // fixture, unlike noActions, makes the prune-off search actually expand
  // and cycle before exhausting.
  const pullLeadsNowhere = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 1), spades: [] },
    tableau: [
      pile([], cards('2:spades')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
    ],
  })
  for (const dead of [noActions, pullLeadsNowhere]) {
    expect(isProvablyLost(dead)).toBe(true)
    expect(solve(dead, { prune: true }).outcome).toBe('unwinnable')
    expect(solve(dead, { prune: false }).outcome).toBe('unwinnable')
  }
})

test('a position beyond section 4 still proves unwinnable by search', () => {
  // Real, non-pointless moves exist (the black 8s can cross onto the red
  // 9s, and freeing a column "helps" by the section 4 counting rule), so
  // the loss detector cannot declare — but with no aces in play the
  // foundations can never start, and every line dead-ends. This is the
  // solver's value-add pinned deterministically.
  const beyond = makeState({
    tableau: [
      pile([], cards('9:hearts')),
      pile([], cards('8:spades')),
      pile([], cards('9:diamonds')),
      pile([], cards('8:clubs')),
      pile([], cards('5:hearts')),
      pile([], cards('5:diamonds')),
      pile([], cards('2:spades')),
    ],
  })
  expect(isProvablyLost(beyond)).toBe(false)
  expect(solve(beyond, { prune: true }).outcome).toBe('unwinnable')
  expect(solve(beyond, { prune: false }).outcome).toBe('unwinnable')
})

test('a budget hit yields undecided, never unwinnable', () => {
  const start = initialState(7, { drawCount: 3 })
  expect(solve(start, { maxNodes: 5 }).outcome).toBe('undecided')
  expect(solve(start, { maxVisited: 3 }).outcome).toBe('undecided')
})

test('solving is deterministic: same position, same verdict, same line', () => {
  const start = initialState(3, { drawCount: 1 })
  const first = solve(start, { maxNodes: 50_000 })
  const second = solve(start, { maxNodes: 50_000 })
  expect(second).toEqual(first)
})

test('the position key ignores the move counter and config, and respects order', () => {
  const base = makeState({ waste: cards('A:clubs', '2:hearts') })
  const moved = { ...base, moves: 41 }
  expect(positionKey(moved)).toBe(positionKey(base))
  const otherConfig = { ...base, config: { drawCount: 1 as const } }
  expect(positionKey(otherConfig)).toBe(positionKey(base))
  const reordered = makeState({ waste: cards('2:hearts', 'A:clubs') })
  expect(positionKey(reordered)).not.toBe(positionKey(base))
  const asStock = makeState({ stock: cards('A:clubs', '2:hearts') })
  expect(positionKey(asStock)).not.toBe(positionKey(base))
})

test('tightenLine rejects an illegal line loudly', () => {
  // The near-win fixture has an empty stock, so a draw is illegal there
  // (recycle would be legal — the waste holds a card).
  const start = nearWinDeal()
  expect(() => tightenLine(start, [{ type: 'draw' }])).toThrow('illegal action in line')
})

// The differential test (DESIGN.md section 12): over positions small
// enough that both runs complete, the solver with pruning on and off must
// agree on every decisive verdict. This is the test that enforces the
// pruning-safety claim — one-sided unwinnable assertions cannot catch
// over-pruning.
test(
  'differential: pruning never changes a decisive verdict',
  () => {
    let decisivePairs = 0
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.constantFrom<1 | 3>(1, 3),
        fc.array(fc.nat(9999), { minLength: 80, maxLength: 160 }),
        (seed, drawCount, picks) => {
          // Drive a real deal deep with arbitrary legal play — late
          // positions are where both searches can actually complete, so
          // the comparison has teeth instead of returning
          // undecided/undecided.
          const state = playout(initialState(seed, { drawCount }), picks)
          const pruned = solve(state, { maxNodes: 12_000, maxVisited: 12_000, prune: true })
          // The unpruned tree is a strict superset, so an equal budget
          // would systematically skip exactly the over-pruning
          // fingerprint (pruned decisive, unpruned out of budget). Give
          // the unpruned run more room, escalating once on the
          // suspicious cell.
          let unpruned = solve(state, { maxNodes: 60_000, maxVisited: 60_000, prune: false })
          if (pruned.outcome !== 'undecided' && unpruned.outcome === 'undecided') {
            unpruned = solve(state, { maxNodes: 240_000, maxVisited: 240_000, prune: false })
          }
          for (const result of [pruned, unpruned]) {
            if (result.outcome === 'won') expect(isWon(replay(state, result.line))).toBe(true)
          }
          if (pruned.outcome === 'undecided' || unpruned.outcome === 'undecided') return
          decisivePairs += 1
          expect(pruned.outcome).toBe(unpruned.outcome)
        },
      ),
      { numRuns: 12 },
    )
    // The harness must not silently go vacuous: at least one property run
    // has to produce a genuine decisive-vs-decisive comparison.
    expect(decisivePairs).toBeGreaterThanOrEqual(1)
  },
  60_000,
)

test('tightenLine splices out a there-and-back detour without changing the outcome', () => {
  // A wasteful prefix: shuttle the king between two empty columns and
  // back, then win. The round trip revisits the start position, so
  // tightening must remove it entirely.
  const kingHome = makeState({
    waste: cards('Q:spades'),
    foundations: { ...fullFoundations(), spades: suitPrefix('spades', 11) },
    tableau: [
      pile([], cards('K:spades')),
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
      EMPTY_PILE,
    ],
  })
  const shuttle: KlondikeAction[] = [
    { type: 'move', from: { kind: 'tableau', index: 0 }, to: { kind: 'tableau', index: 1 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 1 }, to: { kind: 'tableau', index: 0 }, count: 1 },
  ]
  const finish: KlondikeAction[] = [
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'spades' }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 0 }, to: { kind: 'foundation', suit: 'spades' }, count: 1 },
  ]
  const wasteful = [...shuttle, ...finish]
  expect(isWon(replay(kingHome, wasteful))).toBe(true)
  const tightened = tightenLine(kingHome, wasteful)
  expect(tightened).toEqual(finish)
  expect(isWon(replay(kingHome, tightened))).toBe(true)
})

test('any returned winning line is fully legal from the input position', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 50 }), (seed) => {
      const start = initialState(seed, { drawCount: 1 })
      const result = solve(start, { maxNodes: 60_000, maxVisited: 60_000 })
      if (result.outcome !== 'won') return
      // replay throws on any illegal action; reaching the end proves the
      // whole line and the win.
      expect(isWon(replay(start, result.line))).toBe(true)
      const tightened = tightenLine(start, result.line)
      expect(tightened.length).toBeLessThanOrEqual(result.line.length)
      expect(isWon(replay(start, tightened))).toBe(true)
    }),
    { numRuns: 15 },
  )
})
