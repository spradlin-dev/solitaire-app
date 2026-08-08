import { MAX_SEED } from './engine/klondike.ts'
import type { DrawCount } from './engine/klondike.ts'

// Shareable deal links (DESIGN.md section 5.3): the URL fragment carries
// the seed and draw mode, never reaching the server or the service worker.

export interface DealLink {
  readonly seed: number
  readonly drawCount: DrawCount
}

const FRAGMENT_PATTERN = /^#?deal=(\d{1,10})\.([13])$/

export function formatDealFragment(link: DealLink): string {
  // A link the parser would reject must never be handed out: a shared URL
  // that silently opens some other random deal is worse than an error here.
  if (!Number.isInteger(link.seed) || link.seed < 0 || link.seed > MAX_SEED) {
    throw new Error(`invalid seed for a deal link: ${link.seed}`)
  }
  return `#deal=${link.seed}.${link.drawCount}`
}

// Malformed fragments yield null; the caller falls back to a normal new deal.
export function parseDealFragment(fragment: string): DealLink | null {
  const match = FRAGMENT_PATTERN.exec(fragment)
  if (match === null) return null
  const seed = Number(match[1])
  if (seed > MAX_SEED) return null
  return { seed, drawCount: match[2] === '1' ? 1 : 3 }
}
