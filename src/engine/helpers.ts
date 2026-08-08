import { advance, fitsFoundation, isRed, isWon, legalActions, rankIndex } from './klondike.ts'
import type { KlondikeAction, KlondikeState } from './klondike.ts'
import { SUITS, cardKey } from './cards.ts'
import type { Card } from './cards.ts'

// Assist logic built on top of the engine, never inside it: helpers only
// read state and emit primitive engine actions (DESIGN.md section 5.1).

export type MoveAction = Extract<KlondikeAction, { type: 'move' }>

export function isMove(action: KlondikeAction): action is MoveAction {
  return action.type === 'move'
}

// --- Loss detection (DESIGN.md section 4) ---
// Both conditions are pure functions of the position; no tracking flags.
// False positives are forbidden: any legal fact-changing action blocks the
// call. A pointless move (defined with the hint, below) provably preserves
// the position, so it does not block — without this the player whose only
// moves are pointless hops is sent around the stock forever instead of
// being told the game is over.

function hasBlockingMove(state: KlondikeState, actions: readonly KlondikeAction[]): boolean {
  return actions.some((action) => isMove(action) && !isPointless(state, action))
}

function stockWasteKey(state: KlondikeState): string {
  return `${state.stock.map(cardKey).join(',')}|${state.waste.map(cardKey).join(',')}`
}

function cycleStep(state: KlondikeState): KlondikeState | null {
  const action: KlondikeAction | null =
    state.stock.length > 0 ? { type: 'draw' } : state.waste.length > 0 ? { type: 'recycle' } : null
  if (action === null) return null
  const result = advance(state, action)
  return result.ok ? result.state : null
}

export function isProvablyLost(state: KlondikeState): boolean {
  if (isWon(state)) return false
  const actions = legalActions(state)
  if (actions.length === 0) return true
  if (hasBlockingMove(state, actions)) return false
  // Only draws, recycles, and pointless moves remain. With no stock cycle
  // to search, that alone proves the loss.
  if (state.stock.length === 0 && state.waste.length === 0) return true
  // Only draw/recycle remain. Draw/recycle transitions are deterministic
  // and never reorder the deck, so the stock/waste configuration must
  // eventually revisit one it has already been in (a draw-3 start taken
  // mid-pass may never see its own split again, so we track every visited
  // configuration, not just the first). If no position before that revisit
  // offers a move, the game repeats forever and is provably lost.
  const visited = new Set([stockWasteKey(state)])
  let current = state
  for (let step = 0; step < 200; step++) {
    const next = cycleStep(current)
    // Unreachable: draw/recycle conserve a positive stock+waste total. If a
    // broken invariant ever gets here, refuse to declare — false positives
    // are forbidden, so the safe direction is "not proven lost".
    if (next === null) return false
    current = next
    const key = stockWasteKey(current)
    if (visited.has(key)) return true
    visited.add(key)
    // Foundations are frozen during a pure draw/recycle cycle, so the
    // pointlessness of tableau moves is stable across it.
    if (hasBlockingMove(current, legalActions(current))) return false
  }
  // Safety cap reached: refuse to declare a loss we could not prove.
  return false
}

// The game-lost message is deliberately withheld until the player has
// cycled the remaining cards at least once since their last real move:
// the proof may exist earlier, but the player gets to finish looking
// first. Declarable means provably lost AND (nothing left to cycle, or
// the stock sits empty with a recycle on the log since the last
// non-cycle action — i.e. a completed fruitless pass).
export function isLossDeclarable(state: KlondikeState, actionLog: readonly KlondikeAction[]): boolean {
  if (!isProvablyLost(state)) return false
  if (state.stock.length === 0 && state.waste.length === 0) return true
  let recycles = 0
  for (let index = actionLog.length - 1; index >= 0; index--) {
    const action = actionLog[index]
    if (action.type === 'move') break
    if (action.type === 'recycle') recycles += 1
  }
  // One recycle with the stock drawn back to empty is a completed pass;
  // two recycles prove a full pass happened wherever the player is now —
  // the declaration must not depend on catching the exact pass boundary.
  return (recycles >= 1 && state.stock.length === 0) || recycles >= 2
}

// --- Hint (DESIGN.md section 5.3) ---
// Priority: move that flips a face-down card > foundation move > tableau
// move that frees a column or card > waste play > draw or recycle, with a
// regressive foundation-to-tableau move as the last resort. A pointless
// move (below) is never hinted at all, so hint() returns null exactly
// when no fact-changing action exists — the UI reports "no useful move"
// then, unless the loss is provable. Ties break in legalActions order
// (waste first, then tableau columns left to right with longer runs
// first, targets left to right).

// A foundation pull is useful only if its tenant chain grounds in a real,
// currently-visible card. Nothing ever stacks on a tableau ace, and a
// two's only tenant is an ace that never needs the seat, so either pull
// can be deleted from any winning line. A taller pull needs a card one
// rank lower and the opposite color to land on it: the waste top or a
// face-up tableau card grounds the chain, while another foundation's top
// counts only if its own pull is useful in turn (a chain of pulls that
// never reaches a real card shuffles foundations forever). Ranks strictly
// decrease down the chain, so the recursion terminates; deferring any
// still-useless pull is never worse, and whatever move could ever ground
// its chain blocks the loss declaration by itself.
function pullIsUseful(state: KlondikeState, card: Card): boolean {
  if (card.rank === 'A' || card.rank === '2') return false
  const tenant = (candidate: Card) =>
    rankIndex(candidate.rank) === rankIndex(card.rank) - 1 && isRed(candidate.suit) !== isRed(card.suit)
  if (state.waste.length > 0 && tenant(state.waste[state.waste.length - 1])) return true
  for (const tableauPile of state.tableau) {
    for (let index = 0; index < tableauPile.faceUp.length; index++) {
      const candidate = tableauPile.faceUp[index]
      if (!tenant(candidate)) continue
      // A run head grounds the chain: relocating it flips a card or frees
      // a column. A mid-run tenant is a matching-parent hop that grounds
      // only when the parent it would expose can go up — otherwise the
      // chain ends in a move our own rules call pointless.
      if (index === 0) return true
      const parent = tableauPile.faceUp[index - 1]
      if (fitsFoundation(state.foundations[parent.suit], parent.suit, parent)) return true
    }
  }
  for (const suit of SUITS) {
    const other = state.foundations[suit]
    const top = other[other.length - 1]
    if (top !== undefined && tenant(top) && pullIsUseful(state, top)) return true
  }
  return false
}

// Empty columns are consumed only by Kings, and each King consumes at
// most one ever (a King heading a pile with nothing face-down beneath it
// is settled for good — its only remaining move is the pointless
// shuttle). Freeing a column therefore helps only while the empty
// columns on the table are fewer than the Kings that could still want
// one; supply and demand fall together when a King lands, so a satisfied
// table stays satisfied.
function freeingAColumnHelps(state: KlondikeState): boolean {
  let settled = 0
  let empty = 0
  for (const pile of state.tableau) {
    if (pile.faceUp.length === 0 && pile.faceDown.length === 0) empty += 1
    else if (pile.faceDown.length === 0 && pile.faceUp[0].rank === 'K') settled += 1
  }
  return empty < 4 - settled
}

// A pointless move leaves the board functionally unchanged: a lone
// King-led pile hopping between empty columns; a partial run hopping
// between matching parents — every legal partial tableau move has
// matching parents by the fit rule — when the card it would expose cannot
// go to its foundation; a whole pile moved to free a column no King can
// ever use again; or a foundation pull whose tenant chain grounds in no
// real card (pullIsUseful above). The one shared filter consumed by the
// hint, the loss detector, and the solver's pruning (DESIGN.md section
// 12) — defined only on states satisfying the tableau-run invariant.
export function isPointless(state: KlondikeState, move: MoveAction): boolean {
  if (move.from.kind === 'foundation') {
    const pile = state.foundations[move.from.suit]
    const card = pile[pile.length - 1]
    if (card === undefined) return false
    return !pullIsUseful(state, card)
  }
  if (move.from.kind !== 'tableau' || move.to.kind !== 'tableau') return false
  const source = state.tableau[move.from.index]
  if (move.count < source.faceUp.length) {
    const exposed = source.faceUp[source.faceUp.length - move.count - 1]
    return !fitsFoundation(state.foundations[exposed.suit], exposed.suit, exposed)
  }
  if (source.faceDown.length > 0) return false
  const target = state.tableau[move.to.index]
  if (target.faceUp.length === 0 && target.faceDown.length === 0) return true
  // A whole pile onto a non-empty target frees its column — worthless
  // when the open columns already meet every King's possible need.
  return !freeingAColumnHelps(state)
}

export function hint(state: KlondikeState): KlondikeAction | null {
  const actions = legalActions(state)
  const moves = actions.filter(isMove).filter((move) => !isPointless(state, move))
  const forward = moves.filter((move) => move.from.kind !== 'foundation')

  const flipping = forward.filter((move) => {
    if (move.from.kind !== 'tableau') return false
    const pile = state.tableau[move.from.index]
    return pile.faceDown.length > 0 && move.count === pile.faceUp.length
  })
  if (flipping.length > 0) return flipping[0]

  const toFoundation = forward.filter((move) => move.to.kind === 'foundation')
  if (toFoundation.length > 0) return toFoundation[0]

  // Pointless moves are already filtered, so every surviving tableau move
  // frees a column or a card that matters.
  const tableauToTableau = forward.filter((move) => move.from.kind === 'tableau' && move.to.kind === 'tableau')
  if (tableauToTableau.length > 0) return tableauToTableau[0]

  const wastePlay = forward.filter((move) => move.from.kind === 'waste' && move.to.kind === 'tableau')
  if (wastePlay.length > 0) return wastePlay[0]

  const cycle = actions.find((action) => action.type === 'draw' || action.type === 'recycle')
  if (cycle) return cycle

  return moves[0] ?? null
}

// --- Auto-finish (DESIGN.md section 5.3) ---
// The trigger is mode-aware and only ever true when the win is provable:
// with no face-down cards every pile's smallest card is its top, so
// foundation plays plus (in draw 1) draws and recycles always complete the
// game. Draw 3 needs the empty-stock clause because buried stock cards may
// never surface.

export function autoFinishAvailable(state: KlondikeState): boolean {
  if (isWon(state)) return false
  if (state.tableau.some((pile) => pile.faceDown.length > 0)) return false
  // Draw 3 can bury cards forever, but a SINGLE remaining stock-or-waste
  // card is always reachable: it is (or becomes) the waste top directly.
  // Two can hide one under the other for good.
  if (state.config.drawCount === 3) return state.stock.length + state.waste.length <= 1
  return true
}

function nextAutoFinishAction(state: KlondikeState): KlondikeAction | null {
  for (let index = 0; index < 7; index++) {
    const faceUp = state.tableau[index].faceUp
    if (faceUp.length === 0) continue
    const top = faceUp[faceUp.length - 1]
    if (fitsFoundation(state.foundations[top.suit], top.suit, top)) {
      return { type: 'move', from: { kind: 'tableau', index }, to: { kind: 'foundation', suit: top.suit }, count: 1 }
    }
  }
  if (state.waste.length > 0) {
    const top = state.waste[state.waste.length - 1]
    if (fitsFoundation(state.foundations[top.suit], top.suit, top)) {
      return { type: 'move', from: { kind: 'waste' }, to: { kind: 'foundation', suit: top.suit }, count: 1 }
    }
  }
  if (state.stock.length > 0) return { type: 'draw' }
  if (state.waste.length > 0) return { type: 'recycle' }
  return null
}

export function autoFinishActions(state: KlondikeState): KlondikeAction[] {
  if (!autoFinishAvailable(state)) throw new Error('auto-finish is not available from this position')
  const emitted: KlondikeAction[] = []
  let current = state
  for (let guard = 0; guard < 2000; guard++) {
    if (isWon(current)) return emitted
    const action = nextAutoFinishAction(current)
    if (action === null) throw new Error('auto-finish could not progress; the trigger invariant is broken')
    const result = advance(current, action)
    if (!result.ok) throw new Error(`auto-finish emitted a rejected action: ${result.reason}`)
    emitted.push(action)
    current = result.state
  }
  throw new Error('auto-finish exceeded its action budget; the trigger invariant is broken')
}

// --- Tap-to-auto-move (DESIGN.md section 5.3) ---
// Double-tap: foundation first, else the leftmost legal tableau spot.
// Tapping mid-run moves the run from that card down (tableau targets only —
// a multi-card run can never go to a foundation).

export type TapSpot =
  | { readonly kind: 'waste' }
  | { readonly kind: 'tableau'; readonly index: number; readonly cardIndex: number }

export function tapAction(state: KlondikeState, spot: TapSpot): KlondikeAction | null {
  const candidates: KlondikeAction[] = []
  if (spot.kind === 'waste') {
    if (state.waste.length === 0) return null
    const top = state.waste[state.waste.length - 1]
    const from = { kind: 'waste' } as const
    candidates.push({ type: 'move', from, to: { kind: 'foundation', suit: top.suit }, count: 1 })
    for (let index = 0; index < 7; index++) {
      candidates.push({ type: 'move', from, to: { kind: 'tableau', index }, count: 1 })
    }
  } else {
    // A hit-test miss commonly arrives as index -1; a stray tap must be a
    // no-op, never a crash.
    if (!Number.isInteger(spot.index) || spot.index < 0 || spot.index >= 7) return null
    const pile = state.tableau[spot.index]
    if (spot.cardIndex < 0 || spot.cardIndex >= pile.faceUp.length) return null
    const count = pile.faceUp.length - spot.cardIndex
    const from = { kind: 'tableau', index: spot.index } as const
    if (count === 1) {
      const card = pile.faceUp[spot.cardIndex]
      candidates.push({ type: 'move', from, to: { kind: 'foundation', suit: card.suit }, count })
    }
    for (let index = 0; index < 7; index++) {
      if (index === spot.index) continue
      candidates.push({ type: 'move', from, to: { kind: 'tableau', index }, count })
    }
  }
  for (const candidate of candidates) {
    if (advance(state, candidate).ok) return candidate
  }
  return null
}
