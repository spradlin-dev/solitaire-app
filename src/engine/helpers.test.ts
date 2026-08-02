import { expect, test } from 'vitest'
import fc from 'fast-check'
import { autoFinishActions, autoFinishAvailable, hint, isLossDeclarable, isProvablyLost, tapAction } from './helpers.ts'
import { advance, initialState, isWon, legalActions } from './klondike.ts'
import type { KlondikeAction, TableauPile } from './klondike.ts'
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
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 3), spades: [] },
    tableau: [
      pile([], cards('4:spades')),
      pile([], cards('2:spades')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  // The only move is pulling the 3 of hearts down onto the 4 of spades —
  // and the visible 2 of spades could land on it, so the pull blocks.
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

test('the loss is declared only after a fruitless full pass since the last real move', () => {
  const move: KlondikeAction = {
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  }
  // Provably lost with the stock mid-pass: one recycle since the move is
  // not yet a completed pass, but a second recycle proves one happened —
  // the declaration must not require catching the exact pass boundary.
  const midPass = makeState({
    stock: cards('2:clubs', '3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(midPass)).toBe(true)
  expect(isLossDeclarable(midPass, [move, { type: 'recycle' }, { type: 'draw' }])).toBe(false)
  expect(
    isLossDeclarable(midPass, [move, { type: 'recycle' }, { type: 'draw' }, { type: 'recycle' }, { type: 'draw' }]),
  ).toBe(true)

  // A deal with no moves ever still requires one recycle: the first
  // pass alone leaves the stock empty with nothing cycled yet.
  const virginPassDone = makeState({
    waste: cards('2:clubs', '3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isLossDeclarable(virginPassDone, [{ type: 'draw' }])).toBe(false)
  expect(isLossDeclarable(virginPassDone, [{ type: 'draw' }, { type: 'recycle' }, { type: 'draw' }])).toBe(true)

  // Stock drawn empty: declarable only if a recycle happened since the move.
  const passDone = makeState({
    waste: cards('2:clubs', '3:clubs'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(passDone)).toBe(true)
  expect(isLossDeclarable(passDone, [{ type: 'recycle' }, { type: 'draw' }, move, { type: 'draw' }])).toBe(false)
  expect(isLossDeclarable(passDone, [move, { type: 'draw' }, { type: 'recycle' }, { type: 'draw' }])).toBe(true)

  // Nothing left to cycle: declarable immediately.
  const bare = makeState({
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isLossDeclarable(bare, [move])).toBe(true)

  // Never declarable when the game is not provably lost.
  const alive = makeState({
    waste: cards('8:spades'),
    tableau: [pile([], cards('9:hearts')), pile([], cards('9:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isLossDeclarable(alive, [move, { type: 'recycle' }])).toBe(false)
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
    // Walls keep the open-column count below the Kings' possible demand,
    // so consolidating the 6 of spades genuinely frees a useful column.
    tableau: [
      pile([], cards('6:spades')),
      pile([], cards('7:hearts')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      pile([], cards('J:hearts')),
      pile([], cards('J:diamonds')),
      EMPTY_PILE,
    ],
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
    tableau: [
      pile([], cards('7:hearts')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      pile([], cards('J:hearts')),
      pile([], cards('J:diamonds')),
      EMPTY_PILE,
      EMPTY_PILE,
    ],
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

  // Draw 3: one reachable card left is fine; two can bury each other.
  const oneInStockDraw3 = makeState({ stock: cards('K:hearts'), config: { drawCount: 3 } })
  expect(autoFinishAvailable(oneInStockDraw3)).toBe(true)

  const oneInWasteDraw3 = makeState({ waste: cards('K:hearts'), config: { drawCount: 3 } })
  expect(autoFinishAvailable(oneInWasteDraw3)).toBe(true)

  const twoLeftDraw3 = makeState({ stock: cards('Q:hearts'), waste: cards('K:hearts'), config: { drawCount: 3 } })
  expect(autoFinishAvailable(twoLeftDraw3)).toBe(false)

  const stockLeftDraw1 = makeState({ stock: cards('K:hearts', 'Q:hearts'), config: { drawCount: 1 } })
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

test('draw 3 auto-finish plays out a single remaining stock card', () => {
  const state = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 12),
      spades: suitPrefix('spades', 13),
    },
    stock: cards('K:hearts'),
    config: { drawCount: 3 },
  })
  expect(autoFinishAvailable(state)).toBe(true)
  expect(isWon(replay(state, autoFinishActions(state)))).toBe(true)
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

test('when the only legal action is a useful regressive pull, hint returns it rather than null', () => {
  // This position is not lost: the 3 of hearts can come down to catch the
  // visible 2 of spades, and that pull is the hint's last resort.
  const state = makeState({
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 3), spades: [] },
    tableau: [
      pile([], cards('4:spades')),
      pile([], cards('2:spades')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(state)).toBe(false)
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'foundation', suit: 'hearts' },
    to: { kind: 'tableau', index: 0 },
    count: 1,
  })
})

test('a partial-run hop between matching parents is not hinted while the exposed card is useless', () => {
  const state = makeState({
    stock: cards('2:clubs'),
    tableau: [
      pile([], cards('7:hearts', '6:spades')),
      pile([], cards('7:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  // The 6 of spades could hop from one red 7 to the other, but exposing
  // the 7 of hearts buys nothing with the hearts foundation empty.
  expect(hint(state)).toEqual({ type: 'draw' })
})

test('the same hop is hinted once the exposed card can go to its foundation', () => {
  const state = makeState({
    stock: cards('2:clubs'),
    foundations: { clubs: [], diamonds: [], hearts: suitPrefix('hearts', 6), spades: [] },
    tableau: [
      pile([], cards('7:hearts', '6:spades')),
      pile([], cards('7:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 1,
  })
})

test('a board with only pointless moves hints nothing and IS provably lost', () => {
  // The stuck case from play-testing: legal moves exist, but every one of
  // them provably preserves the position, so the player must be told the
  // game is over rather than hinted around the stock forever.
  const state = makeState({
    tableau: [
      pile([], cards('7:hearts', '6:spades')),
      pile([], cards('7:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(legalActions(state).length).toBeGreaterThan(0)
  expect(hint(state)).toBeNull()
  expect(isProvablyLost(state)).toBe(true)
})

test('a bare King shuttle no longer blocks the loss declaration; a flip-enabling King still does', () => {
  const bareKingSterile = makeState({
    stock: cards('2:clubs', '3:clubs'),
    tableau: [
      pile([], cards('K:spades')),
      EMPTY_PILE,
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(bareKingSterile)).toBe(true)

  // The same position with a face-down card under the King is a real
  // move (the hop flips it), so it still blocks.
  const flippingKing = makeState({
    stock: cards('2:clubs', '3:clubs'),
    tableau: [
      pile(cards('7:hearts'), cards('K:spades')),
      EMPTY_PILE,
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(flippingKing)).toBe(false)
})

test('a foundation Ace or Two pulled down is pointless; a Three still blocks the loss', () => {
  const walls: TableauPile[] = [pile([], cards('9:hearts')), pile([], cards('9:diamonds'))]
  // Only "move" available: A of spades down onto the 2 of hearts.
  const aceOnly = makeState({
    stock: cards('J:clubs', 'J:spades'),
    foundations: { clubs: [], diamonds: [], hearts: [], spades: suitPrefix('spades', 1) },
    tableau: [...walls, pile([], cards('2:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(aceOnly)).toBe(true)

  // Only "move" available: 2 of spades down onto the 3 of hearts.
  const twoOnly = makeState({
    stock: cards('J:clubs', 'J:spades'),
    foundations: { clubs: [], diamonds: [], hearts: [], spades: suitPrefix('spades', 2) },
    tableau: [...walls, pile([], cards('3:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(twoOnly)).toBe(true)

  // A 3 pulled down blocks only while a tenant for it is visible: with a
  // red 2 face up the pull could catch it, without one it is pointless.
  const threeWithTenant = makeState({
    stock: cards('J:clubs', 'J:spades'),
    foundations: { clubs: [], diamonds: [], hearts: [], spades: suitPrefix('spades', 3) },
    tableau: [
      ...walls,
      pile([], cards('4:hearts')),
      pile([], cards('2:hearts')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(threeWithTenant)).toBe(false)

  const threeWithoutTenant = makeState({
    stock: cards('J:clubs', 'J:spades'),
    foundations: { clubs: [], diamonds: [], hearts: [], spades: suitPrefix('spades', 3) },
    tableau: [...walls, pile([], cards('4:hearts')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  expect(isProvablyLost(threeWithoutTenant)).toBe(true)
})

test('a buried King already served by an open column does not justify freeing another', () => {
  // One unsettled King (face-down under the 5 of hearts) but one column
  // already open: supply meets demand, so emptying the 9's column buys
  // nothing — and with a sterile stock, that makes this a provable loss.
  const served = makeState({
    stock: cards('2:clubs'),
    tableau: [
      pile([], cards('K:spades')),
      pile([], cards('K:hearts')),
      pile([], cards('K:diamonds')),
      pile(cards('K:clubs'), cards('5:hearts')),
      pile([], cards('10:clubs')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(served)).toBe(true)
})

test('freeing a column is pointless once all four Kings are settled', () => {
  // The play-reported case: a lone 9 of diamonds could hop onto the 10 of
  // clubs to empty its column, but with every King already heading a
  // column no King can ever use the space.
  const allSettled = makeState({
    stock: cards('2:clubs'),
    tableau: [
      pile([], cards('K:spades')),
      pile([], cards('K:hearts')),
      pile([], cards('K:diamonds')),
      pile([], cards('K:clubs')),
      pile([], cards('10:clubs')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE,
    ],
  })
  expect(hint(allSettled)).toEqual({ type: 'draw' })
  expect(isProvablyLost(allSettled)).toBe(true)

  // With one King still sitting on a face-down card, a freed column could
  // receive it, so the same move is useful again.
  const oneUnsettled = makeState({
    stock: cards('2:clubs'),
    tableau: [
      pile([], cards('K:spades')),
      pile([], cards('K:hearts')),
      pile([], cards('K:diamonds')),
      pile(cards('2:hearts'), cards('K:clubs')),
      pile([], cards('10:clubs')),
      pile([], cards('9:diamonds')),
      pile([], cards('3:spades')),
    ],
  })
  expect(hint(oneUnsettled)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 5 },
    to: { kind: 'tableau', index: 4 },
    count: 1,
  })
  expect(isProvablyLost(oneUnsettled)).toBe(false)
})

test('a chain of foundation pulls blocks only when it grounds in a real visible card', () => {
  // The 4 of spades can come down to the 5 of diamonds only to seat the
  // 3 of diamonds from its foundation — which itself only matters if a
  // black 2 is genuinely visible to land on it.
  const base = {
    stock: cards('J:clubs', 'J:spades'),
    foundations: {
      clubs: [],
      diamonds: suitPrefix('diamonds', 3),
      hearts: [],
      spades: suitPrefix('spades', 4),
    },
  }
  const grounded = makeState({
    ...base,
    tableau: [
      pile([], cards('5:diamonds')),
      pile([], cards('2:clubs')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(grounded)).toBe(false)

  const ungrounded = makeState({
    ...base,
    tableau: [
      pile([], cards('5:diamonds')),
      pile([], cards('9:clubs')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(ungrounded)).toBe(true)
})

test('a mid-run tenant grounds a foundation pull only when its own hop would be useful', () => {
  const base = {
    stock: cards('J:clubs', 'J:spades'),
    foundations: { clubs: [], diamonds: suitPrefix('diamonds', 4), hearts: [], spades: [] },
  }
  // The only black 3 sits mid-run under a 4 of hearts that cannot go up:
  // relocating it onto a pulled-down 4 of diamonds would be a pointless
  // hop, so the pull chain grounds nowhere and the game is over.
  const deadEnd = makeState({
    ...base,
    tableau: [
      pile([], cards('5:clubs')),
      pile(cards('9:spades'), cards('5:spades', '4:hearts', '3:spades')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(deadEnd)).toBe(true)

  // With hearts built to 3, exposing the 4 of hearts is real progress, so
  // the same tenant grounds the pull and blocks the declaration.
  const grounded = makeState({
    ...base,
    foundations: { ...base.foundations, hearts: suitPrefix('hearts', 3) },
    tableau: [
      pile([], cards('5:clubs')),
      pile(cards('9:spades'), cards('5:spades', '4:hearts', '3:spades')),
      pile([], cards('9:hearts')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(grounded)).toBe(false)
})

test('the play-reported position: ace-down as the only real-looking move, ace in waste buried by draw-3', () => {
  // Verbatim from a player report: the stock cycle is sterile (the A of
  // hearts never surfaces under draw-3 alignment) and the only
  // fact-changing-looking move was pulling the A of spades down. This
  // must be a provable loss.
  const log: KlondikeAction[] = [
    { type: 'move', from: { kind: 'tableau', index: 0 }, to: { kind: 'tableau', index: 5 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 3 }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 2 }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'diamonds' }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 1 }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 2 }, count: 1 },
    { type: 'recycle' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 1 }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'clubs' }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'clubs' }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 1 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 5 }, to: { kind: 'tableau', index: 1 }, count: 2 },
    { type: 'move', from: { kind: 'tableau', index: 5 }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 6 }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 2 }, to: { kind: 'tableau', index: 6 }, count: 3 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 3 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 4 }, to: { kind: 'tableau', index: 3 }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 4 }, to: { kind: 'foundation', suit: 'spades' }, count: 1 },
    { type: 'move', from: { kind: 'tableau', index: 4 }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 6 }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'recycle' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'clubs' }, count: 1 },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'clubs' }, count: 1 },
    { type: 'draw' },
    { type: 'recycle' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'recycle' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
    { type: 'draw' },
  ]
  const state = replay(initialState(2996239298, { drawCount: 3 }), log)
  expect(isProvablyLost(state)).toBe(true)
})

test('a useless partial hop plus a sterile cycle is a provable loss', () => {
  const state = makeState({
    stock: cards('2:clubs', '3:clubs'),
    tableau: [
      pile([], cards('7:hearts', '6:spades')),
      pile([], cards('7:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(isProvablyLost(state)).toBe(true)
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
    // Spades built to 7 makes the short hop useful (it exposes the 8 of
    // spades for the foundation); the walls keep open columns scarce so
    // the whole-run move is useful too. Both live in the same tier and
    // legalActions order puts the longer run first.
    foundations: { clubs: [], diamonds: [], hearts: [], spades: suitPrefix('spades', 7) },
    tableau: [
      pile([], cards('9:hearts', '8:spades', '7:diamonds')),
      pile([], cards('10:spades')),
      pile([], cards('8:clubs')),
      pile([], cards('Q:hearts')),
      pile([], cards('Q:diamonds')),
      EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(hint(state)).toEqual({
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 3,
  })
})
