import { expect, test } from 'vitest'
import { advance, initialState, isWon, legalActions, rankIndex } from './klondike.ts'
import type { KlondikeAction } from './klondike.ts'
import { SUITS, cardKey } from './cards.ts'
import type { Card } from './cards.ts'
import { SHUFFLED_SEED_42 as G, cards } from './testCards.ts'
import { EMPTY_PILE, makeState, mustAdvance, pile, suitPrefix } from './testState.ts'

function keys(pile: readonly Card[]): string[] {
  return pile.map(cardKey)
}

test('rankIndex is the total order A=0 .. K=12', () => {
  expect(rankIndex('A')).toBe(0)
  expect(rankIndex('2')).toBe(1)
  expect(rankIndex('10')).toBe(9)
  expect(rankIndex('J')).toBe(10)
  expect(rankIndex('Q')).toBe(11)
  expect(rankIndex('K')).toBe(12)
})

test('the deal has piles of 1-7 with only the top face up, and a stock of 24', () => {
  const state = initialState(42, { drawCount: 3 })
  expect(state.tableau).toHaveLength(7)
  for (let i = 0; i < 7; i++) {
    expect(state.tableau[i].faceDown).toHaveLength(i)
    expect(state.tableau[i].faceUp).toHaveLength(1)
  }
  expect(state.stock).toHaveLength(24)
  expect(state.waste).toHaveLength(0)
  for (const suit of SUITS) expect(state.foundations[suit]).toHaveLength(0)
  expect(state.moves).toBe(0)

  const all = [
    ...state.stock,
    ...state.tableau.flatMap((p) => [...p.faceDown, ...p.faceUp]),
  ]
  expect(new Set(all.map(cardKey)).size).toBe(52)
})

test('the seed-42 deal matches the golden shuffle order, column by column', () => {
  // Expected piles derived BY HAND from G and the documented convention
  // (deal column by column popping from the deck top; last card dealt is
  // the face-up top): pile 0 pops G[51]; pile 1 pops G[50] then G[49]; etc.
  const state = initialState(42, { drawCount: 3 })
  expect(keys(state.tableau[0].faceUp)).toEqual([G[51]])
  expect(keys(state.tableau[1].faceDown)).toEqual([G[50]])
  expect(keys(state.tableau[1].faceUp)).toEqual([G[49]])
  expect(keys(state.tableau[2].faceDown)).toEqual([G[48], G[47]])
  expect(keys(state.tableau[2].faceUp)).toEqual([G[46]])
  expect(keys(state.tableau[3].faceDown)).toEqual([G[45], G[44], G[43]])
  expect(keys(state.tableau[3].faceUp)).toEqual([G[42]])
  expect(keys(state.tableau[4].faceDown)).toEqual([G[41], G[40], G[39], G[38]])
  expect(keys(state.tableau[4].faceUp)).toEqual([G[37]])
  expect(keys(state.tableau[5].faceDown)).toEqual([G[36], G[35], G[34], G[33], G[32]])
  expect(keys(state.tableau[5].faceUp)).toEqual([G[31]])
  expect(keys(state.tableau[6].faceDown)).toEqual([G[30], G[29], G[28], G[27], G[26], G[25]])
  expect(keys(state.tableau[6].faceUp)).toEqual([G[24]])
  expect(keys(state.stock)).toEqual(G.slice(0, 24))
})

test('dealing the same seed twice is identical; a different seed differs', () => {
  const a = initialState(7, { drawCount: 1 })
  const b = initialState(7, { drawCount: 1 })
  const c = initialState(8, { drawCount: 1 })
  expect(a).toEqual(b)
  expect(a.tableau).not.toEqual(c.tableau)
})

// Pinned conventions fixture (DESIGN.md section 3): exact waste after each
// of the first draws in draw 3, and exact stock order after a recycle.
test('draw 3 puts the third card popped on top of the waste, and recycle flips the waste over', () => {
  let state = makeState({ stock: cards('A:clubs', '2:clubs', '3:clubs', '4:clubs', '5:clubs') })

  state = mustAdvance(state, { type: 'draw' })
  expect(keys(state.waste)).toEqual(['5:clubs', '4:clubs', '3:clubs'])
  expect(keys(state.stock)).toEqual(['A:clubs', '2:clubs'])

  state = mustAdvance(state, { type: 'draw' })
  expect(keys(state.waste)).toEqual(['5:clubs', '4:clubs', '3:clubs', '2:clubs', 'A:clubs'])
  expect(state.stock).toHaveLength(0)

  state = mustAdvance(state, { type: 'recycle' })
  expect(keys(state.stock)).toEqual(['A:clubs', '2:clubs', '3:clubs', '4:clubs', '5:clubs'])
  expect(state.waste).toHaveLength(0)

  // A move-free second pass exposes exactly the same sequence.
  state = mustAdvance(state, { type: 'draw' })
  expect(keys(state.waste)).toEqual(['5:clubs', '4:clubs', '3:clubs'])
})

test('draw 1 moves exactly one card, and a short final draw takes what is left', () => {
  let state = makeState({ stock: cards('A:clubs', '2:clubs'), config: { drawCount: 1 } })
  state = mustAdvance(state, { type: 'draw' })
  expect(keys(state.waste)).toEqual(['2:clubs'])

  let short = makeState({ stock: cards('A:clubs', '2:clubs') })
  short = mustAdvance(short, { type: 'draw' })
  expect(keys(short.waste)).toEqual(['2:clubs', 'A:clubs'])
  expect(short.stock).toHaveLength(0)
})

test('draw is rejected on an empty stock; recycle needs an empty stock and a non-empty waste', () => {
  const empty = makeState({})
  expect(advance(empty, { type: 'draw' })).toEqual({ ok: false, reason: 'draw-stock-empty' })
  expect(advance(empty, { type: 'recycle' })).toEqual({ ok: false, reason: 'recycle-waste-empty' })
  const stocked = makeState({ stock: cards('A:clubs'), waste: cards('2:clubs') })
  expect(advance(stocked, { type: 'recycle' })).toEqual({ ok: false, reason: 'recycle-stock-not-empty' })
})

test('waste top moves to a fitting tableau card; a buried waste card cannot move', () => {
  const state = makeState({
    waste: cards('9:hearts', '6:spades'),
    tableau: [pile([], cards('7:diamonds')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  const moved = mustAdvance(state, {
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'tableau', index: 0 },
    count: 1,
  })
  expect(keys(moved.tableau[0].faceUp)).toEqual(['7:diamonds', '6:spades'])
  expect(keys(moved.waste)).toEqual(['9:hearts'])
})

test('tableau fit requires one rank lower and the opposite color', () => {
  const base = makeState({
    waste: cards('6:diamonds'),
    tableau: [
      pile([], cards('7:diamonds')),
      pile([], cards('7:spades')),
      pile([], cards('6:spades')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  const from = { kind: 'waste' } as const
  expect(advance(base, { type: 'move', from, to: { kind: 'tableau', index: 0 }, count: 1 })).toMatchObject({
    ok: false,
    reason: 'does-not-fit',
  })
  expect(advance(base, { type: 'move', from, to: { kind: 'tableau', index: 2 }, count: 1 })).toMatchObject({
    ok: false,
    reason: 'does-not-fit',
  })
  expect(advance(base, { type: 'move', from, to: { kind: 'tableau', index: 1 }, count: 1 }).ok).toBe(true)
})

test('a multi-card run moves intact onto a fitting top', () => {
  const state = makeState({
    tableau: [
      pile(cards('K:hearts'), cards('9:hearts', '8:spades', '7:diamonds')),
      pile([], cards('10:spades')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  const moved = mustAdvance(state, {
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 3,
  })
  expect(keys(moved.tableau[1].faceUp)).toEqual(['10:spades', '9:hearts', '8:spades', '7:diamonds'])
  // The exposed face-down card flips automatically.
  expect(moved.tableau[0].faceDown).toHaveLength(0)
  expect(keys(moved.tableau[0].faceUp)).toEqual(['K:hearts'])
})

test('a partial run moves from mid-run, leaving the rest behind', () => {
  const state = makeState({
    tableau: [
      pile([], cards('9:hearts', '8:spades', '7:diamonds')),
      pile([], cards('9:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  const moved = mustAdvance(state, {
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 2,
  })
  expect(keys(moved.tableau[0].faceUp)).toEqual(['9:hearts'])
  expect(keys(moved.tableau[1].faceUp)).toEqual(['9:diamonds', '8:spades', '7:diamonds'])
})

test('face-down cards never move as part of a run', () => {
  const state = makeState({
    tableau: [
      pile(cards('9:hearts'), cards('8:spades')),
      pile([], cards('10:diamonds')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 0 }, to: { kind: 'tableau', index: 1 }, count: 2 }),
  ).toEqual({ ok: false, reason: 'no-such-card' })
})

test('an empty column accepts a King or a King-led run, and nothing else', () => {
  const state = makeState({
    waste: cards('Q:hearts'),
    tableau: [
      pile([], cards('K:spades', 'Q:diamonds')),
      EMPTY_PILE,
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(
    advance(state, { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 1 }, count: 1 }),
  ).toEqual({ ok: false, reason: 'does-not-fit' })
  const moved = mustAdvance(state, {
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'tableau', index: 1 },
    count: 2,
  })
  expect(keys(moved.tableau[1].faceUp)).toEqual(['K:spades', 'Q:diamonds'])
})

test('foundations build A upward in suit; wrong rank or suit is rejected', () => {
  let state = makeState({
    waste: cards('A:hearts'),
    tableau: [pile([], cards('2:hearts')), pile([], cards('2:spades')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  state = mustAdvance(state, {
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'foundation', suit: 'hearts' },
    count: 1,
  })
  expect(keys(state.foundations.hearts)).toEqual(['A:hearts'])
  state = mustAdvance(state, {
    type: 'move',
    from: { kind: 'tableau', index: 0 },
    to: { kind: 'foundation', suit: 'hearts' },
    count: 1,
  })
  expect(keys(state.foundations.hearts)).toEqual(['A:hearts', '2:hearts'])
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 1 }, to: { kind: 'foundation', suit: 'spades' }, count: 1 }),
  ).toEqual({ ok: false, reason: 'does-not-fit' })
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 1 }, to: { kind: 'foundation', suit: 'hearts' }, count: 1 }),
  ).toEqual({ ok: false, reason: 'does-not-fit' })
})

test('a foundation top may come back down onto a fitting tableau card', () => {
  const state = makeState({
    foundations: { clubs: [], diamonds: [], hearts: cards('A:hearts', '2:hearts'), spades: [] },
    tableau: [pile([], cards('3:spades')), EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
  })
  const moved = mustAdvance(state, {
    type: 'move',
    from: { kind: 'foundation', suit: 'hearts' },
    to: { kind: 'tableau', index: 0 },
    count: 1,
  })
  expect(keys(moved.foundations.hearts)).toEqual(['A:hearts'])
  expect(keys(moved.tableau[0].faceUp)).toEqual(['3:spades', '2:hearts'])
})

test('malformed moves are rejected with precise reasons', () => {
  const state = makeState({ waste: cards('7:hearts') })
  const from = { kind: 'waste' } as const
  expect(advance(state, { type: 'move', from, to: { kind: 'waste' }, count: 1 })).toEqual({
    ok: false,
    reason: 'invalid-zone',
  })
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 7 }, to: { kind: 'tableau', index: 0 }, count: 1 }),
  ).toEqual({ ok: false, reason: 'invalid-zone' })
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 2 }, to: { kind: 'tableau', index: 2 }, count: 1 }),
  ).toEqual({ ok: false, reason: 'invalid-zone' })
  expect(advance(state, { type: 'move', from, to: { kind: 'tableau', index: 0 }, count: 0 })).toEqual({
    ok: false,
    reason: 'invalid-count',
  })
  expect(advance(state, { type: 'move', from, to: { kind: 'tableau', index: 0 }, count: 2 })).toEqual({
    ok: false,
    reason: 'invalid-count',
  })
  expect(
    advance(state, { type: 'move', from: { kind: 'foundation', suit: 'clubs' }, to: { kind: 'tableau', index: 0 }, count: 1 }),
  ).toEqual({ ok: false, reason: 'no-such-card' })
})

test('legalActions canonicalizes multiple empty columns to the leftmost, but advance accepts any', () => {
  const state = makeState({
    tableau: [
      pile([], cards('K:spades')),
      EMPTY_PILE,
      EMPTY_PILE,
      pile([], cards('4:hearts')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
    waste: cards('K:diamonds'),
  })
  const kingMoves = legalActions(state).filter(
    (a) => a.type === 'move' && a.from.kind === 'waste' && a.to.kind === 'tableau',
  )
  expect(kingMoves).toEqual([
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 1 }, count: 1 },
  ])
  expect(
    advance(state, { type: 'move', from: { kind: 'waste' }, to: { kind: 'tableau', index: 4 }, count: 1 }).ok,
  ).toBe(true)
})

test('every action legalActions emits is accepted by advance on a real deal', () => {
  let state = initialState(1234, { drawCount: 3 })
  for (let step = 0; step < 40; step++) {
    const actions = legalActions(state)
    for (const action of actions) {
      expect(advance(state, action).ok).toBe(true)
    }
    if (actions.length === 0) break
    state = mustAdvance(state, actions[step % actions.length])
  }
})

test('isWon exactly when all four foundations hold 13 cards', () => {
  const won = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 13),
      spades: suitPrefix('spades', 13),
    },
  })
  expect(isWon(won)).toBe(true)
  const almost = makeState({
    foundations: {
      clubs: suitPrefix('clubs', 13),
      diamonds: suitPrefix('diamonds', 13),
      hearts: suitPrefix('hearts', 13),
      spades: suitPrefix('spades', 12),
    },
  })
  expect(isWon(almost)).toBe(false)
})

test('every successful action of any type counts as one move', () => {
  let state = makeState({ stock: cards('A:clubs'), config: { drawCount: 1 } })
  state = mustAdvance(state, { type: 'draw' })
  expect(state.moves).toBe(1)
  state = mustAdvance(state, { type: 'recycle' })
  expect(state.moves).toBe(2)
  state = mustAdvance(state, { type: 'draw' })
  state = mustAdvance(state, {
    type: 'move',
    from: { kind: 'waste' },
    to: { kind: 'foundation', suit: 'clubs' },
    count: 1,
  })
  expect(state.moves).toBe(4)
})

test('advance is total: garbage from a corrupted log rejects instead of throwing', () => {
  const state = initialState(42, { drawCount: 3 })
  const garbage = [
    { type: 'flip' },
    { type: 'move', from: { kind: 'stock' }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'move', from: { kind: 'foundation', suit: 'wands' }, to: { kind: 'tableau', index: 0 }, count: 1 },
    { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: 'wands' }, count: 1 },
    { type: 'move', from: undefined, to: { kind: 'tableau', index: 0 }, count: 1 },
    null,
  ] as unknown as KlondikeAction[]
  for (const action of garbage) {
    expect(advance(state, action)).toEqual({ ok: false, reason: 'invalid-zone' })
  }
})

test('a face-up selection that is not a real run is rejected', () => {
  // Crafted states bypass the deal, so the run invariant cannot be assumed.
  const state = makeState({
    tableau: [
      pile([], cards('9:hearts', '2:clubs')),
      pile([], cards('10:spades')),
      EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE,
    ],
  })
  expect(
    advance(state, { type: 'move', from: { kind: 'tableau', index: 0 }, to: { kind: 'tableau', index: 1 }, count: 2 }),
  ).toEqual({ ok: false, reason: 'not-a-run' })
})
