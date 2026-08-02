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

// Golden fixture: the seed-42 shuffle order, computed with the canonical
// mulberry32 reference and a textbook Fisher-Yates (j = value % (i + 1),
// i from 51 down to 1) over the canonical clubs/diamonds/hearts/spades x
// A..K deck, independently of src/engine. Index 0 is the deck bottom, 51
// the top. Shared so the deck and deal tests pin against ONE reference.
// prettier-ignore
export const SHUFFLED_SEED_42 = [
  '4:diamonds', 'J:clubs', 'K:hearts', 'Q:clubs', '4:clubs', '7:spades',
  '7:hearts', 'A:clubs', '6:spades', '9:spades', '10:diamonds', 'J:diamonds',
  '6:clubs', '10:clubs', '8:hearts', '2:hearts', '3:clubs', 'Q:hearts',
  '9:hearts', '5:spades', '7:clubs', '8:diamonds', '3:diamonds', 'A:spades',
  'Q:diamonds', '2:clubs', '2:spades', '3:spades', 'K:clubs', '10:hearts',
  '8:clubs', '3:hearts', 'J:spades', '7:diamonds', '4:hearts', '6:diamonds',
  'K:diamonds', 'K:spades', '9:clubs', 'A:diamonds', 'A:hearts', '9:diamonds',
  '5:hearts', '2:diamonds', '5:diamonds', 'J:hearts', 'Q:spades', '4:spades',
  '8:spades', '5:clubs', '6:hearts', '10:spades',
]
