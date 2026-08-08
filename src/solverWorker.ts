import { positionKey, solve, tightenLine } from './engine/solver.ts'
import type { KlondikeAction, KlondikeState } from './engine/klondike.ts'

// The search runs here at machine speed so the table never janks; the
// full position crosses the boundary by structured clone, and every
// reply carries the position key it solved so the shell can drop stale
// results (DESIGN.md section 12).

export type SolverWorkerReply =
  | { readonly key: string; readonly outcome: 'won'; readonly line: readonly KlondikeAction[] }
  | { readonly key: string; readonly outcome: 'unwinnable' | 'undecided' }

self.onmessage = (event: MessageEvent<{ state: KlondikeState }>) => {
  const { state } = event.data
  const key = positionKey(state)
  const result = solve(state)
  const reply: SolverWorkerReply =
    result.outcome === 'won'
      ? { key, outcome: 'won', line: tightenLine(state, result.line) }
      : { key, outcome: result.outcome }
  self.postMessage(reply)
}
