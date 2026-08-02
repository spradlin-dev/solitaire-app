import { expect, test } from 'vitest'
import fc from 'fast-check'
import { advance, initialState, legalActions, rankIndex } from './klondike.ts'
import type { KlondikeAction, KlondikeConfig, KlondikeState, Zone } from './klondike.ts'
import { SUITS, cardKey } from './cards.ts'
import type { Suit } from './cards.ts'

const arbSeed = fc.integer({ min: 0, max: 0xffffffff })
const arbConfig: fc.Arbitrary<KlondikeConfig> = fc
  .constantFrom<1 | 3>(1, 3)
  .map((drawCount) => ({ drawCount }))
const arbPicks = fc.array(fc.nat(9999), { minLength: 1, maxLength: 60 })

// Random legal playout: at each step pick one of the currently legal actions.
// Every visited state is returned, first to last.
function playout(seed: number, config: KlondikeConfig, picks: readonly number[]): KlondikeState[] {
  let state = initialState(seed, config)
  const trace = [state]
  for (const pick of picks) {
    const actions = legalActions(state)
    if (actions.length === 0) break
    const result = advance(state, actions[pick % actions.length])
    if (!result.ok) throw new Error(`legalActions emitted a rejected action: ${result.reason}`)
    state = result.state
    trace.push(state)
  }
  return trace
}

function allCardKeys(state: KlondikeState): string[] {
  return [
    ...state.stock,
    ...state.waste,
    ...SUITS.flatMap((suit) => [...state.foundations[suit]]),
    ...state.tableau.flatMap((pile) => [...pile.faceDown, ...pile.faceUp]),
  ].map(cardKey)
}

function isRed(suit: Suit): boolean {
  return suit === 'diamonds' || suit === 'hearts'
}

test('card conservation: every reachable state contains exactly the 52 unique cards', () => {
  fc.assert(
    fc.property(arbSeed, arbConfig, arbPicks, (seed, config, picks) => {
      for (const state of playout(seed, config, picks)) {
        const keys = allCardKeys(state)
        expect(keys).toHaveLength(52)
        expect(new Set(keys).size).toBe(52)
      }
    }),
    { numRuns: 50 },
  )
})

test('tableau-run invariant: every reachable face-up section descends by one, alternating colors', () => {
  fc.assert(
    fc.property(arbSeed, arbConfig, arbPicks, (seed, config, picks) => {
      for (const state of playout(seed, config, picks)) {
        for (const pile of state.tableau) {
          if (pile.faceUp.length === 0) expect(pile.faceDown).toHaveLength(0)
          for (let i = 1; i < pile.faceUp.length; i++) {
            const upper = pile.faceUp[i - 1]
            const lower = pile.faceUp[i]
            expect(rankIndex(lower.rank)).toBe(rankIndex(upper.rank) - 1)
            expect(isRed(lower.suit)).not.toBe(isRed(upper.suit))
          }
        }
      }
    }),
    { numRuns: 50 },
  )
})

test('determinism: same seed and same action sequence produce the identical state', () => {
  fc.assert(
    fc.property(arbSeed, arbConfig, arbPicks, (seed, config, picks) => {
      const a = playout(seed, config, picks)
      const b = playout(seed, config, picks)
      expect(a[a.length - 1]).toEqual(b[b.length - 1])
    }),
    { numRuns: 30 },
  )
})

test('advance is pure: it never mutates the state it is given', () => {
  // The store's undo cache keeps every previous state by reference, so an
  // in-place mutation would silently rewrite history without failing any
  // replay-based test.
  fc.assert(
    fc.property(arbSeed, arbConfig, arbPicks, (seed, config, picks) => {
      let state = initialState(seed, config)
      for (const pick of picks) {
        const actions = legalActions(state)
        if (actions.length === 0) break
        const before = JSON.stringify(state)
        const result = advance(state, actions[pick % actions.length])
        expect(JSON.stringify(state)).toBe(before)
        if (!result.ok) throw new Error('legal action rejected')
        state = result.state
      }
    }),
    { numRuns: 30 },
  )
})

// Brute-force oracle: try EVERY syntactically possible action through advance
// and keep what it accepts, reduced by the same public canonicalization rule
// legalActions documents (one action per (from, count) among empty-column
// targets: the leftmost). The enumeration is independent of legalActions'
// internals, so this pins ENUMERATION completeness and soundness against
// advance — the rules themselves are pinned by the unit tests, since both
// sides here share advance's judgment of what fits.
function oracleActions(state: KlondikeState): KlondikeAction[] {
  const sources: Zone[] = [
    { kind: 'waste' },
    ...Array.from({ length: 7 }, (_, index): Zone => ({ kind: 'tableau', index })),
    ...SUITS.map((suit): Zone => ({ kind: 'foundation', suit })),
  ]
  const targets: Zone[] = [
    ...Array.from({ length: 7 }, (_, index): Zone => ({ kind: 'tableau', index })),
    ...SUITS.map((suit): Zone => ({ kind: 'foundation', suit })),
  ]
  const accepted: KlondikeAction[] = []
  for (const type of ['draw', 'recycle'] as const) {
    if (advance(state, { type }).ok) accepted.push({ type })
  }
  for (const from of sources) {
    const maxCount = from.kind === 'tableau' ? 13 : 1
    for (const to of targets) {
      for (let count = 1; count <= maxCount; count++) {
        const action: KlondikeAction = { type: 'move', from, to, count }
        if (advance(state, action).ok) accepted.push(action)
      }
    }
  }

  const isEmptyColumn = (zone: Zone): boolean =>
    zone.kind === 'tableau' &&
    state.tableau[zone.index].faceUp.length === 0 &&
    state.tableau[zone.index].faceDown.length === 0

  const seenEmptyTarget = new Set<string>()
  return accepted.filter((action) => {
    if (action.type !== 'move' || !isEmptyColumn(action.to)) return true
    const key = JSON.stringify([action.from, action.count])
    if (seenEmptyTarget.has(key)) return false
    seenEmptyTarget.add(key)
    return true
  })
}

function sortedActionKeys(actions: readonly KlondikeAction[]): string[] {
  return actions.map((action) => JSON.stringify(action)).sort()
}

test('oracle equivalence: legalActions returns exactly what brute-force advance accepts', () => {
  fc.assert(
    fc.property(arbSeed, arbConfig, arbPicks, (seed, config, picks) => {
      const trace = playout(seed, config, picks)
      // Check a bounded sample of the trace to keep the run fast: the
      // opening states, every fifth state through the tangled middle game,
      // and the final position.
      const sample = trace.filter((_, index) => index < 8 || index % 5 === 0 || index === trace.length - 1)
      for (const state of sample) {
        expect(sortedActionKeys(legalActions(state))).toEqual(sortedActionKeys(oracleActions(state)))
      }
    }),
    { numRuns: 25 },
  )
})
