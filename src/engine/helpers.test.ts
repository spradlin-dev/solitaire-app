import { expect, test } from 'vitest'
import fc from 'fast-check'
import { autoFinishActions, autoFinishAvailable, hint, isProvablyLost, tapAction } from './helpers.ts'
import { advance, initialState, isWon, legalActions } from './klondike.ts'
import type { TableauPile } from './klondike.ts'
import { RANKS } from './cards.ts'
import type { Card } from './cards.ts'
import { cards } from './testCards.ts'
import { EMPTY_PILE, makeState, pile, replay, suitPrefix } from './testState.ts'

// --- Loss detection ---

test('a position with no legal actions at all is lost; a won game never is', () => {
  const dead = makeState({
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(legalActions(dead)).toHaveLength(0)
  expect(isProvablyLost(dead)).toBe(true)

  const won = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 13),
      spades: suitPrefix('spades', 13),
    },
  })
  expect(isProvablyLost(won)).toBe(false)
})

test('an available foundation-to-tableau move blocks the loss declaration', () => {
  const blocked = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 2), spades: [] },
    tableau: [pile([], cards('3:spades')), pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  // The only move is pulling the 2 of hearts back down onto the 3 of spades.
  expect(isProvablyLost(blocked)).toBe(false)

  const noFoundationCard = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 1), spades: [] },
    tableau: [pile([], cards('3:spades')), pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  // The ace fits no tableau card, so now nothing is legal.
  expect(isProvablyLost(noFoundationCard)).toBe(true)
})

test('an available King-to-empty-column move blocks the loss declaration', () => {
  const withEmpty = makeState({
    tableau: [pile(cards('7:hearts'), cards('K:spades')), EMPTY_PILE, pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(withEmpty)).toBe(false)

  const noEmpty = makeState({
    tableau: [
      pile(cards('7:hearts'), cards('K:spades')),
      pile([], cards('9:clubs')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      pile([], cards('J:hearts')),
      pile([], cards('J:diamonds')),
      pile([], cards('2:spades')),
    ],
  })
  expect(isProvablyLost(noEmpty)).toBe(true)
})

test('a sterile stock cycle is a provable loss; one playable buried card breaks it', () => {
  const sterile = makeState({
    stock: cards('2:clubs', '3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(sterile)).toBe(true)

  const playable = makeState({
    stock: cards('2:clubs', '8:spades', '3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
    config: { drawCount: 1 },
  })
  expect(isProvablyLost(playable)).toBe(false)
})

test('draw 3 can bury a playable card forever where draw 1 would surface it', () => {
  // Six stock cards with the playable 8 of spades second from the bottom:
  // in draw 3 the waste tops are only ever the 4 and 2 of clubs, so the 8
  // never surfaces; in draw 1 every card gets its turn on top.
  const stock = cards('2:clubs', '8:spades', '3:clubs', '4:clubs', '5:clubs', '6:clubs')
  const tableau: TableauPile[] = [
    pile([], cards('9:hearts')),
    pile([], cards('9:diamonds')),
    EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
  ]
  expect(isProvablyLost(makeState({ stock, tableau, config: { drawCount: 3 } }))).toBe(true)
  expect(isProvablyLost(makeState({ stock, tableau, config: { drawCount: 1 } }))).toBe(false)
})

test('a sterile cycle that starts mid-pass is still detected in draw 3', () => {
  // The start split (stock [2c], waste [3c]) can never recur after a
  // recycle re-aligns the multi-card draws; the detector must recognize
  // the revisited configuration instead of waiting for the original one.
  const midPass = makeState({
    stock: cards('2:clubs'),
    waste: cards('3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(midPass)).toBe(true)
})

// --- Hint ---

test('a move that flips a face-down card beats a foundation move', () => {
  const state = makeState({
    waste: cards('A:clubs'),
    tableau: [pile(cards('2:diamonds'), cards('6:spades')), pile([], cards('7:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  })
})

test('a foundation move beats a plain tableau move', () => {
  const state = makeState({
    tableau: [pile([], cards('A:clubs')), pile([], cards('6:spades')), pile([], cards('7:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'foundation', suit: 'clubs' },
    count: 1,
  })
})

test('a tableau move beats a waste play, and a waste play beats drawing', () => {
  const both = makeState({
    waste: cards('6:clubs'),
    stock: cards('2:clubs'),
    tableau: [pile([], cards('6:spades')), pile([], cards('7:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(both)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  })

  const wasteOnly = makeState({
    waste: cards('6:clubs'),
    stock: cards('2:clubs'),
    tableau: [pile([], cards('7:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(wasteOnly)).toEqual({
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'tableau', index: 0 },
    count: 1,
  })
})

test('a foundation-to-tableau move is never hinted; draw or recycle is suggested instead', () => {
  const withStock = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 2), spades: [] },
    stock: cards('2:clubs'),
    tableau: [pile([], cards('3:spades')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(withStock)).toEqual({ type: 'draw' })

  const withWaste = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 2), spades: [] },
    waste: cards('2:clubs'),
    tableau: [pile([], cards('3:spades')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(withWaste)).toEqual({ type: 'recycle' })
})

test('hint returns null only when nothing at all is legal', () => {
  const dead = makeState({
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(hint(dead)).toBeNull()
})

test('hint never returns an action the engine rejects', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 0xffffffff }),
      fc.constantFrom<1 | 3>(1, 3),
      fc.array(fc.nat(9999), { maxLength: 40 }),
      (seed, drawCount, picks) => {
        let state = initialState(seed, { drawCount })
        for (const pick of picks) {
          const suggestion = hint(state)
          if (suggestion !== null) expect(advance(state, suggestion).ok).toBe(true)
          const actions = legalActions(state)
          if (actions.length === 0) break
          const result = advance(state, actions[pick % actions.length])
          if (!result.ok) throw new Error('legal action rejected')
          state = result.state
        }
      },
    ),
    { numRuns: 30 },
  )
})

// --- Auto-finish ---

test('the auto-finish trigger is mode-aware', () => {
  const faceDownLeft = makeState({
    tableau: [pile(cards('2:clubs'), cards('K:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
    config: { drawCount: 1 },
  })
  expect(autoFinishAvailable(faceDownLeft)).toBe(false)

  const stockLeftDraw3 = makeState({ stock: cards('K:hearts'), config: { drawCount: 3 } })
  expect(autoFinishAvailable(stockLeftDraw3)).toBe(false)

  const stockLeftDraw1 = makeState({ stock: cards('K:hearts'), config: { drawCount: 1 } })
  expect(autoFinishAvailable(stockLeftDraw1)).toBe(true)

  const won = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 13),
      spades: suitPrefix('spades', 13),
    },
  })
  expect(autoFinishAvailable(won)).toBe(false)

  expect(() => autoFinishActions(faceDownLeft)).toThrow('not available')
})

test('draw 3 auto-finish completes a fully exposed tableau', () => {
  const state = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 11),
      diamonds: suitPrefix('diamonds', 11),
      hearts: suitPrefix('hearts', 11),
      spades: suitPrefix('spades', 11),
    },
    tableau: [
      pile([], cards('K:hearts', 'Q:spades')),
      pile([], cards('K:clubs', 'Q:diamonds')),
      pile([], cards('K:diamonds', 'Q:clubs')),
      pile([], cards('K:spades', 'Q:hearts')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
    config: { drawCount: 3 },
  })
  const actions = autoFinishActions(state)
  expect(actions).toHaveLength(8)
  expect(isWon(replay(state, actions))).toBe(true)
})

test('draw 1 auto-finish draws and recycles its way through the stock and waste', () => {
  const state = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 11),
      spades: suitPrefix('spades', 13),
    },
    // The waste top is the King, which cannot play before its Queen: the
    // finisher must recycle and re-draw to get underneath it.
    waste: cards('Q:hearts', 'K:hearts'),
    config: { drawCount: 1 },
  })
  const actions = autoFinishActions(state)
  expect(actions).toContainEqual({ type: 'recycle' })
  expect(isWon(replay(state, actions))).toBe(true)
})

test('draw 1 auto-finish wins from any foundation split across tableau, stock, and waste', () => {
  fc.assert(
    fc.property(
      fc.record({
        clubs: fc.nat(13),
        diamonds: fc.nat(13),
        hearts: fc.nat(13),
        spades: fc.nat(12),
      }),
      fc.array(fc.nat(2), { minLength: 52, maxLength: 52 }),
      (cuts, destinations) => {
        const foundations = {
          clubs: suitPrefix('clubs', cuts.clubs),
          diamonds: suitPrefix('diamonds', cuts.diamonds),
          hearts: suitPrefix('hearts', cuts.hearts),
          spades: suitPrefix('spades', cuts.spades),
        }
        const leftovers = (['clubs', 'diamonds', 'hearts', 'spades'] as const).flatMap((suit) =>
          RANKS.slice(cuts[suit]).map((rank) => ({ rank, suit })),
        )
        // Spread the leftovers across all three places the trigger allows:
        // single-card tableau piles (trivially valid runs), the stock, and
        // the waste — the finisher must interleave tableau plays with
        // draws and recycles.
        const stock: Card[] = []
        const waste: Card[] = []
        const singles: Card[] = []
        leftovers.forEach((card, index) => {
          const destination = destinations[index]
          if (destination === 2 && singles.length < 7) singles.push(card)
          else if (destination === 1) waste.push(card)
          else stock.push(card)
        })
        const tableau = Array.from({ length: 7 }, (_, index) =>
          index < singles.length ? pile([], [singles[index]]) : EMPTY_PILE,
        )
        const state = makeState({ foundations, stock, waste, tableau, config: { drawCount: 1 } })
        expect(autoFinishAvailable(state)).toBe(true)
        expect(isWon(replay(state, autoFinishActions(state)))).toBe(true)
      },
    ),
    { numRuns: 40 },
  )
})

// --- Tap-to-auto-move ---

test('tapping prefers the foundation over a fitting tableau card', () => {
  const state = makeState({
    waste: cards('A:clubs'),
    tableau: [pile([], cards('2:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(tapAction(state, { kind: 'waste' })).toEqual({
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'foundation', suit: 'clubs' },
    count: 1,
  })
})

test('tapping picks the leftmost legal tableau spot', () => {
  const state = makeState({
    waste: cards('6:diamonds'),
    tableau: [
      pile([], cards('9:hearts')),
      pile([], cards('7:spades')),
      pile([], cards('7:clubs')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(tapAction(state, { kind: 'waste' })).toEqual({
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  })
})

test('tapping mid-run moves the run from that card down', () => {
  const state = makeState({
    tableau: [
      pile([], cards('9:hearts', '8:spades', '7:diamonds')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(tapAction(state, { kind: 'tableau', index: 0, cardIndex: 1 })).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 2,
  })
})

test('tapping a King finds the leftmost empty column', () => {
  const state = makeState({
    tableau: [
      pile([], cards('K:spades', 'Q:diamonds')),
      pile([], cards('4:clubs')),
      EMPTY_PILE,
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(tapAction(state, { kind: 'tableau', index: 0, cardIndex: 0 })).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 2 },
    count: 2,
  })
})

test('tapping with no destination, an empty waste, or a bad card index returns null', () => {
  const state = makeState({
    waste: cards('9:clubs'),
    tableau: [pile([], cards('5:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(tapAction(state, { kind: 'waste' })).toBeNull()
  expect(tapAction(makeState({}), { kind: 'waste' })).toBeNull()
  expect(tapAction(state, { kind: 'tableau', index: 0, cardIndex: 5 })).toBeNull()
})

test('tapping an out-of-range column is a no-op, never a crash', () => {
  // A pixi hit-test miss arrives as index -1.
  const state = makeState({
    tableau: [pile([], cards('5:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(tapAction(state, { kind: 'tableau', index: -1, cardIndex: 0 })).toBeNull()
  expect(tapAction(state, { kind: 'tableau', index: 7, cardIndex: 0 })).toBeNull()
})

test('tapping a lone tableau top that fits its foundation prefers the foundation', () => {
  const state = makeState({
    tableau: [
      pile([], cards('A:clubs')),
      pile([], cards('2:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(tapAction(state, { kind: 'tableau', index: 0, cardIndex: 0 })).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'foundation', suit: 'clubs' },
    count: 1,
  })
})

test('hint never shuttles a lone King between empty columns past a real play', () => {
  // The exact runaway found in review: without the "frees a column or
  // card" clause the hint proposed King 0 -> 1, then 1 -> 0, forever.
  const state = makeState({
    waste: cards('5:diamonds'),
    tableau: [
      pile([], cards('K:spades')),
      EMPTY_PILE,
      pile([], cards('6:spades')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'tableau', index: 2 },
    count: 1,
  })
})

test('when the only legal action is regressive, hint returns it rather than null', () => {
  // Null must mean "nothing is legal at all" — the UI shows the lost
  // message exactly then. This position is not lost: the 2 of hearts can
  // come back down.
  const state = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 2), spades: [] },
    tableau: [pile([], cards('3:spades')), pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(state)).toBe(false)
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'foundation', suit: 'hearts' },
    to: { kind: 'tableau', index: 0 },
    count: 1,
  })
})

test('hint tie-break: two flip-enabling moves resolve to the leftmost source column', () => {
  const state = makeState({
    tableau: [
      pile(cards('2:diamonds'), cards('6:spades')),
      pile([], cards('7:hearts')),
      pile(cards('2:clubs'), cards('9:diamonds')),
      pile([], cards('10:spades')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  })
})

test('hint tie-break: within a tier, the longer run beats the shorter one from the same pile', () => {
  const state = makeState({
    tableau: [
      pile([], cards('9:hearts', '8:spades', '7:diamonds')),
      pile([], cards('10:spades')),
      pile([], cards('8:clubs')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  // Both the whole run (onto the 10) and the lone 7 (onto the 8) free
  // something; legalActions order puts the longer run first.
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 3,
  })
})
