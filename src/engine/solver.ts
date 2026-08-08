import { advance, isWon, legalActions } from './klondike.ts'
import type { KlondikeAction, KlondikeState } from './klondike.ts'
import { SUITS } from './cards.ts'
import { isMove, isPointless } from './helpers.ts'

// Exhaustive depth-first search over the perfect-information game
// (DESIGN.md section 12). The solver sees face-down cards — that is the
// cheat that makes it tractable: known cards mean one deterministic game
// tree instead of a search over every hidden arrangement.

export type SolverResult =
  | { readonly outcome: 'won'; readonly line: readonly KlondikeAction[] }
  | { readonly outcome: 'unwinnable' }
  | { readonly outcome: 'undecided' }

export interface SolverOptions {
  // Node and visited-entry caps only — never wall-clock — so a given
  // position always yields the same verdict and the same line.
  readonly maxNodes?: number
  readonly maxVisited?: number
  // The differential test runs with pruning off; production never does.
  readonly prune?: boolean
}

// Placeholder budgets pending real measurement in the worker phase: the
// visited set holds full key strings, so its cap is also the memory cap —
// a phone's worker dies of memory long before a desktop would.
const DEFAULT_MAX_NODES = 1_000_000
const DEFAULT_MAX_VISITED = 500_000

// The position key is the state minus `moves` and `config`: `advance`
// never reads `moves`, and `config` is constant for a whole deal, so
// winnability is exactly a function of what the key keeps. Face-down
// cards enter as COUNTS: within one deal a pile's face-down portion is
// always a prefix of what was dealt, so the count recovers the
// identities. Stock and waste keep their full order — the draw-3 phase
// makes the split and order load-bearing. Counts-as-identity (face-down
// piles, foundation heights) assumes per-suit-prefix foundations — true
// for every reachable state, violable only by crafted fixtures.
const cardToken = (c: { rank: string; suit: string }) => c.suit[0] + c.rank
const pileToken = (cards: readonly { rank: string; suit: string }[]) => cards.map(cardToken).join('.')

export function positionKey(state: KlondikeState): string {
  return (
    pileToken(state.stock) +
    ';' +
    pileToken(state.waste) +
    ';' +
    SUITS.map((suit) => state.foundations[suit].length).join('.') +
    ';' +
    state.tableau.map((p) => `${p.faceDown.length}:${pileToken(p.faceUp)}`).join('|')
  )
}

// Foundation moves and face-down flips first, with legalActions' stable
// emission order as the total tie-break — wins are found early and
// verdicts are reproducible.
function orderedActions(state: KlondikeState, prune: boolean): KlondikeAction[] {
  const actions = prune
    ? legalActions(state).filter((action) => !isMove(action) || !isPointless(state, action))
    : legalActions(state)
  const score = (action: KlondikeAction): number => {
    if (action.type !== 'move') return 2
    if (action.to.kind === 'foundation') return 0
    if (action.from.kind === 'tableau') {
      const source = state.tableau[action.from.index]
      if (action.count === source.faceUp.length && source.faceDown.length > 0) return 1
    }
    return 2
  }
  return actions.map((action, index) => ({ action, index, score: score(action) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.action)
}

interface Frame {
  readonly state: KlondikeState
  readonly actions: readonly KlondikeAction[]
  next: number
}

// `unwinnable` is returned only when the search exhausts with no budget
// event of any kind: any cap hit anywhere makes the whole result
// `undecided`, and the visited set never answers "visited" for a
// position it did not store (DESIGN.md section 12).
export function solve(start: KlondikeState, options: SolverOptions = {}): SolverResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const maxVisited = options.maxVisited ?? DEFAULT_MAX_VISITED
  const prune = options.prune ?? true
  if (isWon(start)) return { outcome: 'won', line: [] }
  const visited = new Set<string>([positionKey(start)])
  const stack: Frame[] = [{ state: start, actions: orderedActions(start, prune), next: 0 }]
  const path: KlondikeAction[] = []
  let nodes = 0
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.next >= frame.actions.length) {
      stack.pop()
      path.pop()
      continue
    }
    const action = frame.actions[frame.next]
    frame.next += 1
    nodes += 1
    if (nodes > maxNodes) return { outcome: 'undecided' }
    const result = advance(frame.state, action)
    // legalActions ⊆ advance-accepted is a property-tested contract; a
    // rejection here would be an engine bug, not a dead branch.
    if (!result.ok) throw new Error(`legal action rejected during search: ${result.reason}`)
    const child = result.state
    if (isWon(child)) {
      return { outcome: 'won', line: [...path, action] }
    }
    const key = positionKey(child)
    if (visited.has(key)) continue
    if (visited.size >= maxVisited) return { outcome: 'undecided' }
    visited.add(key)
    path.push(action)
    stack.push({ state: child, actions: orderedActions(child, prune), next: 0 })
  }
  return { outcome: 'unwinnable' }
}

// The cleanup pass before playback: replay the line, and when a position
// key repeats, splice out the actions between the repeats. The spliced
// line reaches an identical position, so it cannot change the outcome.
export function tightenLine(start: KlondikeState, line: readonly KlondikeAction[]): KlondikeAction[] {
  let current = [...line]
  let spliced = true
  while (spliced) {
    spliced = false
    const seen = new Map<string, number>([[positionKey(start), 0]])
    let state = start
    for (let i = 0; i < current.length; i++) {
      const result = advance(state, current[i])
      if (!result.ok) throw new Error(`illegal action in line at ${i}: ${result.reason}`)
      state = result.state
      const key = positionKey(state)
      const earlier = seen.get(key)
      if (earlier !== undefined) {
        current = [...current.slice(0, earlier), ...current.slice(i + 1)]
        spliced = true
        break
      }
      seen.set(key, i + 1)
    }
  }
  return current
}
