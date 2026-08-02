import { RANKS, SUITS, cardKey } from './cards.ts'
import type { Card, Rank, Suit } from './cards.ts'

// Builds cards from 'rank:suit' specs, throwing on any typo so a bad
// fixture fails at the fixture, not as a baffling engine assertion.
export function cards(...specs: string[]): Card[] {
  return specs.map((spec) => {
    const [rank, suit] = spec.split(':')
    if (
      !(RANKS as readonly string[]).includes(rank) ||
      !(SUITS as readonly string[]).includes(suit)
    ) {
      throw new Error(`bad card spec: "${spec}"`)
    }
    return { rank: rank as Rank, suit: suit as Suit }
  })
}

export function sortedKeys(found: readonly Card[]): string[] {
  return found.map(cardKey).sort()
}
