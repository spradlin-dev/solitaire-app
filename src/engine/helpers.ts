import { advance, fitsFoundation, isWon, legalActions } from './klondike.ts'
import type { KlondikeAction, KlondikeState } from './klondike.ts'
import { cardKey } from './cards.ts'

// Assist logic built on top of the engine, never inside it: helpers only
// read state and emit primitive engine actions (DESIGN.md section 5.1).

type MoveAction = Extract<KlondikeAction, { type: 'move' }>

function isMove(action: KlondikeAction): action is MoveAction {
  return action.type === 'move'
}

// --- Loss detection (DESIGN.md section 4) ---
// Both conditions are pure functions of the position; no tracking flags.
// False positives are forbidden: any legal non-draw action blocks the call.

function hasMoveAction(actions: readonly KlondikeAction[]): boolean {
  return actions.some(isMove)
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
  if (hasMoveAction(actions)) return false
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
    if (hasMoveAction(legalActions(current))) return false
  }
  // Safety cap reached: refuse to declare a loss we could not prove.
  return false
}

// --- Hint (DESIGN.md section 5.3) ---
// Priority: move that flips a face-down card > foundation move > tableau
// move that frees a column or card > waste play > draw or recycle. A
// regressive move (foundation to tableau, or a null-progress shuttle) is
// only ever a last resort, so hint() returns null exactly when no action
// at all is legal. Ties break in legalActions order (waste first, then
// tableau columns left to right with longer runs first, targets left to
// right).
export function hint(state: KlondikeState): KlondikeAction | null {
  const actions = legalActions(state)
  const moves = actions.filter(isMove)
  const forward = moves.filter((move) => move.from.kind !== 'foundation')

  const flipping = forward.filter((move) => {
    if (move.from.kind !== 'tableau') return false
    const pile = state.tableau[move.from.index]
    return pile.faceDown.length > 0 && move.count === pile.faceUp.length
  })
  if (flipping.length > 0) return flipping[0]

  const toFoundation = forward.filter((move) => move.to.kind === 'foundation')
  if (toFoundation.length > 0) return toFoundation[0]

  // "Frees a column or card", taken literally: a partial run move exposes
  // the card beneath, and a whole-pile move to a non-empty target nets a
  // freed column. A whole-pile move to another empty column frees nothing —
  // without this exclusion the hint shuttles a lone King between two empty
  // columns forever.
  const freeing = forward.filter((move) => {
    if (move.from.kind !== 'tableau' || move.to.kind !== 'tableau') return false
    const source = state.tableau[move.from.index]
    if (move.count < source.faceUp.length) return true
    return source.faceDown.length === 0 && state.tableau[move.to.index].faceUp.length > 0
  })
  if (freeing.length > 0) return freeing[0]

  const wastePlay = forward.filter((move) => move.from.kind === 'waste' && move.to.kind === 'tableau')
  if (wastePlay.length > 0) return wastePlay[0]

  const cycle = actions.find((action) => action.type === 'draw' || action.type === 'recycle')
  if (cycle) return cycle

  // Last resort: a regressive or null-progress move still unblocks the
  // position, and returning it keeps the contract "null means nothing is
  // legal" that the UI's lost-message logic relies on.
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
  if (state.config.drawCount === 3) return state.stock.length === 0 && state.waste.length === 0
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
