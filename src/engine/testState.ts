import { advance, legalActions } from './klondike.ts'
import type { KlondikeAction, KlondikeState, TableauPile } from './klondike.ts'
import { RANKS } from './cards.ts'
import type { Card, Suit } from './cards.ts'
import { cards } from './testCards.ts'

// Shared builders for hand-crafted engine states in tests. Crafted states
// bypass the deal, so keeping one copy of the KlondikeState shape here means
// a future state field is added in exactly one place.

export function pile(faceDown: readonly Card[], faceUp: readonly Card[]): TableauPile {
  return { faceDown, faceUp }
}

export const EMPTY_PILE = pile([], [])

export function makeState(partial: Partial<KlondikeState>): KlondikeState {
  return {
    stock: [],
    waste: [],
    foundations: { clubs: [], diamonds: [], hearts: [], spades: [] },
    tableau: [EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE, EMPTY_PILE],
    config: { drawCount: 3 },
    moves: 0,
    ...partial,
  }
}

// The first `upTo` ranks of a suit, in foundation order; upTo 13 is the
// full suit.
export function suitPrefix(suit: Suit, upTo: number): Card[] {
  return RANKS.slice(0, upTo).map((rank) => ({ rank, suit }))
}

export function mustAdvance(state: KlondikeState, action: KlondikeAction): KlondikeState {
  const result = advance(state, action)
  if (!result.ok) throw new Error(`expected legal action, rejected: ${result.reason}`)
  return result.state
}

export function replay(state: KlondikeState, actions: readonly KlondikeAction[]): KlondikeState {
  let current = state
  for (const action of actions) current = mustAdvance(current, action)
  return current
}

// All four suits complete — the won position, and the base for near-win
// fixtures that peel cards back off.
export function fullFoundations(): Record<Suit, Card[]> {
  return {
    clubs: suitPrefix('clubs', 13),
    diamonds: suitPrefix('diamonds', 13),
    hearts: suitPrefix('hearts', 13),
    spades: suitPrefix('spades', 13),
  }
}

// Random-legal-playout driver: each pick indexes into the legal actions
// mod their count. For plain drive-to-a-position use; tests needing the
// full trace or per-step assertions keep their own loops deliberately.
export function playout(state: KlondikeState, picks: readonly number[]): KlondikeState {
  let current = state
  for (const pick of picks) {
    const actions = legalActions(current)
    if (actions.length === 0) break
    current = mustAdvance(current, actions[pick % actions.length])
  }
  return current
}

// One move from victory: the King of spades waits on the waste.
export function nearWinDeal(): KlondikeState {
  return makeState({
    waste: cards('K:spades'),
    foundations: { ...fullFoundations(), spades: suitPrefix('spades', 12) },
  })
}

export const WINNING_MOVE = {
  type: 'move',
  from: { kind: 'waste' },
  to: { kind: 'foundation', suit: 'spades' },
  count: 1,
} as const
