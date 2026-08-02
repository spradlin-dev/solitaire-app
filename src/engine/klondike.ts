import { RANKS, SUITS } from './cards.ts'
import type { Card, Rank, Suit } from './cards.ts'
import { newDeck, shuffle } from './deck.ts'

export interface KlondikeConfig {
  readonly drawCount: 1 | 3
}

export interface TableauPile {
  readonly faceDown: readonly Card[]
  readonly faceUp: readonly Card[]
}

// Every pile is ordered bottom-first: the last element is the top card.
// The draw-3 ordering and the loss-detection proof both lean on this
// convention (DESIGN.md section 3); fixture tests pin it.
export interface KlondikeState {
  readonly stock: readonly Card[]
  readonly waste: readonly Card[]
  readonly foundations: Readonly<Record<Suit, readonly Card[]>>
  readonly tableau: readonly TableauPile[]
  readonly config: KlondikeConfig
  readonly moves: number
}

export type Zone =
  | { readonly kind: 'waste' }
  | { readonly kind: 'tableau'; readonly index: number }
  | { readonly kind: 'foundation'; readonly suit: Suit }

export type KlondikeAction =
  | { readonly type: 'draw' }
  | { readonly type: 'recycle' }
  | { readonly type: 'move'; readonly from: Zone; readonly to: Zone; readonly count: number }

export type RejectReason =
  | 'draw-stock-empty'
  | 'recycle-stock-not-empty'
  | 'recycle-waste-empty'
  | 'invalid-zone'
  | 'invalid-count'
  | 'no-such-card'
  | 'not-a-run'
  | 'does-not-fit'

// The seed domain shared by deal links, saved games, and their tests.
export const MAX_SEED = 0xffffffff

export type AdvanceResult =
  | { readonly ok: true; readonly state: KlondikeState }
  | { readonly ok: false; readonly reason: RejectReason }

const RANK_TO_INDEX = new Map<Rank, number>(RANKS.map((rank, index) => [rank, index]))

export function rankIndex(rank: Rank): number {
  return RANK_TO_INDEX.get(rank)!
}

function isRed(suit: Suit): boolean {
  return suit === 'diamonds' || suit === 'hearts'
}

function fitsTableau(pile: TableauPile, card: Card): boolean {
  if (pile.faceUp.length === 0) {
    return pile.faceDown.length === 0 && card.rank === 'K'
  }
  const top = pile.faceUp[pile.faceUp.length - 1]
  return rankIndex(card.rank) === rankIndex(top.rank) - 1 && isRed(card.suit) !== isRed(top.suit)
}

export function fitsFoundation(pile: readonly Card[], suit: Suit, card: Card): boolean {
  return card.suit === suit && rankIndex(card.rank) === pile.length
}

export function initialState(seed: number, config: KlondikeConfig): KlondikeState {
  const deck = shuffle(newDeck(), seed).cards
  // Deal column by column, popping from the top of the shuffled deck (the
  // array's end); the last card dealt to each pile is its face-up top.
  let cursor = deck.length
  const tableau: TableauPile[] = []
  for (let column = 0; column < 7; column++) {
    const size = column + 1
    const dealt = deck.slice(cursor - size, cursor).reverse()
    cursor -= size
    tableau.push({ faceDown: dealt.slice(0, size - 1), faceUp: [dealt[size - 1]] })
  }
  return {
    stock: deck.slice(0, cursor),
    waste: [],
    foundations: { clubs: [], diamonds: [], hearts: [], spades: [] },
    tableau,
    config,
    moves: 0,
  }
}

export function isWon(state: KlondikeState): boolean {
  return SUITS.every((suit) => state.foundations[suit].length === RANKS.length)
}

function zonesEqual(a: Zone, b: Zone): boolean {
  if (a.kind === 'waste') return b.kind === 'waste'
  if (a.kind === 'tableau') return b.kind === 'tableau' && a.index === b.index
  return b.kind === 'foundation' && a.suit === b.suit
}

function validTableauIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < 7
}

// Replayed action logs can carry arbitrary JSON; a malformed zone must
// reject, never throw.
function validZone(zone: Zone): boolean {
  if (typeof zone !== 'object' || zone === null) return false
  if (zone.kind === 'waste') return true
  if (zone.kind === 'tableau') return validTableauIndex(zone.index)
  if (zone.kind === 'foundation') return (SUITS as readonly string[]).includes(zone.suit)
  return false
}

function isValidRun(cards: readonly Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    const upper = cards[i - 1]
    const lower = cards[i]
    if (rankIndex(lower.rank) !== rankIndex(upper.rank) - 1 || isRed(lower.suit) === isRed(upper.suit)) {
      return false
    }
  }
  return true
}

function applyDraw(state: KlondikeState): AdvanceResult {
  if (state.stock.length === 0) return { ok: false, reason: 'draw-stock-empty' }
  const n = Math.min(state.config.drawCount, state.stock.length)
  const kept = state.stock.slice(0, state.stock.length - n)
  // Cards land on the waste in pop order, so the last card popped from the
  // stock ends up as the playable waste top (in draw 3: the third card).
  const drawn = state.stock.slice(state.stock.length - n).reverse()
  return { ok: true, state: { ...state, stock: kept, waste: [...state.waste, ...drawn], moves: state.moves + 1 } }
}

function applyRecycle(state: KlondikeState): AdvanceResult {
  if (state.stock.length !== 0) return { ok: false, reason: 'recycle-stock-not-empty' }
  if (state.waste.length === 0) return { ok: false, reason: 'recycle-waste-empty' }
  // Physically flipping the waste over: the first card ever drawn becomes
  // the next card drawn.
  const stock = [...state.waste].reverse()
  return { ok: true, state: { ...state, stock, waste: [], moves: state.moves + 1 } }
}

function applyMove(state: KlondikeState, from: Zone, to: Zone, count: number): AdvanceResult {
  if (!validZone(from) || !validZone(to)) return { ok: false, reason: 'invalid-zone' }
  if (to.kind === 'waste') return { ok: false, reason: 'invalid-zone' }
  if (zonesEqual(from, to)) return { ok: false, reason: 'invalid-zone' }
  if (!Number.isInteger(count) || count < 1) return { ok: false, reason: 'invalid-count' }
  if (from.kind !== 'tableau' && count !== 1) return { ok: false, reason: 'invalid-count' }
  if (to.kind === 'foundation' && count !== 1) return { ok: false, reason: 'invalid-count' }

  let moving: readonly Card[]
  if (from.kind === 'waste') {
    if (state.waste.length === 0) return { ok: false, reason: 'no-such-card' }
    moving = state.waste.slice(-1)
  } else if (from.kind === 'foundation') {
    const pile = state.foundations[from.suit]
    if (pile.length === 0) return { ok: false, reason: 'no-such-card' }
    moving = pile.slice(-1)
  } else {
    const pile = state.tableau[from.index]
    if (pile.faceUp.length < count) return { ok: false, reason: 'no-such-card' }
    moving = pile.faceUp.slice(pile.faceUp.length - count)
    // Reachable states hold the run invariant, but crafted or corrupted
    // states are first-class citizens in tests and replays.
    if (!isValidRun(moving)) return { ok: false, reason: 'not-a-run' }
  }

  if (to.kind === 'tableau') {
    if (!fitsTableau(state.tableau[to.index], moving[0])) return { ok: false, reason: 'does-not-fit' }
  } else if (!fitsFoundation(state.foundations[to.suit], to.suit, moving[0])) {
    return { ok: false, reason: 'does-not-fit' }
  }

  let waste = state.waste
  const foundations = { ...state.foundations }
  const tableau = [...state.tableau]

  if (from.kind === 'waste') {
    waste = waste.slice(0, -1)
  } else if (from.kind === 'foundation') {
    foundations[from.suit] = foundations[from.suit].slice(0, -1)
  } else {
    const pile = tableau[from.index]
    let faceUp = pile.faceUp.slice(0, pile.faceUp.length - count)
    let faceDown = pile.faceDown
    if (faceUp.length === 0 && faceDown.length > 0) {
      // An exposed face-down card flips face up automatically.
      faceUp = faceDown.slice(-1)
      faceDown = faceDown.slice(0, -1)
    }
    tableau[from.index] = { faceDown, faceUp }
  }

  if (to.kind === 'tableau') {
    const pile = tableau[to.index]
    tableau[to.index] = { faceDown: pile.faceDown, faceUp: [...pile.faceUp, ...moving] }
  } else {
    foundations[to.suit] = [...foundations[to.suit], moving[0]]
  }

  return { ok: true, state: { ...state, waste, foundations, tableau, moves: state.moves + 1 } }
}

// Pure and total: any malformed action (a replayed log is arbitrary JSON)
// rejects rather than throws. Every successful action of any type counts
// as one move.
export function advance(state: KlondikeState, action: KlondikeAction): AdvanceResult {
  if (typeof action !== 'object' || action === null) return { ok: false, reason: 'invalid-zone' }
  if (action.type === 'draw') return applyDraw(state)
  if (action.type === 'recycle') return applyRecycle(state)
  if (action.type === 'move') return applyMove(state, action.from, action.to, action.count)
  return { ok: false, reason: 'invalid-zone' }
}

// Every legal tableau target for `card`, canonicalizing empty columns to the
// leftmost one (advance itself accepts any empty column).
function tableauTargets(state: KlondikeState, card: Card, exclude: number | null): number[] {
  const targets: number[] = []
  let emptyUsed = false
  for (let index = 0; index < 7; index++) {
    if (index === exclude) continue
    const pile = state.tableau[index]
    const isEmpty = pile.faceUp.length === 0 && pile.faceDown.length === 0
    if (isEmpty && emptyUsed) continue
    if (fitsTableau(pile, card)) {
      targets.push(index)
      if (isEmpty) emptyUsed = true
    }
  }
  return targets
}

// Complete and sound over concrete actions: every emitted action is accepted
// by advance, and everything advance accepts is emitted (modulo the
// leftmost-empty-column canonicalization). Loss detection and hints rest on
// this contract; it is property-tested against a brute-force oracle.
export function legalActions(state: KlondikeState): KlondikeAction[] {
  const actions: KlondikeAction[] = []
  if (state.stock.length > 0) actions.push({ type: 'draw' })
  if (state.stock.length === 0 && state.waste.length > 0) actions.push({ type: 'recycle' })

  const wasteTop = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null
  if (wasteTop) {
    const from: Zone = { kind: 'waste' }
    if (fitsFoundation(state.foundations[wasteTop.suit], wasteTop.suit, wasteTop)) {
      actions.push({ type: 'move', from, to: { kind: 'foundation', suit: wasteTop.suit }, count: 1 })
    }
    for (const index of tableauTargets(state, wasteTop, null)) {
      actions.push({ type: 'move', from, to: { kind: 'tableau', index }, count: 1 })
    }
  }

  for (let index = 0; index < 7; index++) {
    const faceUp = state.tableau[index].faceUp
    const from: Zone = { kind: 'tableau', index }
    for (let count = faceUp.length; count >= 1; count--) {
      const first = faceUp[faceUp.length - count]
      if (count === 1 && fitsFoundation(state.foundations[first.suit], first.suit, first)) {
        actions.push({ type: 'move', from, to: { kind: 'foundation', suit: first.suit }, count })
      }
      for (const target of tableauTargets(state, first, index)) {
        actions.push({ type: 'move', from, to: { kind: 'tableau', index: target }, count })
      }
    }
  }

  for (const suit of SUITS) {
    const pile = state.foundations[suit]
    if (pile.length === 0) continue
    const top = pile[pile.length - 1]
    const from: Zone = { kind: 'foundation', suit }
    for (const index of tableauTargets(state, top, null)) {
      actions.push({ type: 'move', from, to: { kind: 'tableau', index }, count: 1 })
    }
  }

  return actions
}
