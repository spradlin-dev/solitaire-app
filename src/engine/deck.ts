import { RANKS, SUITS } from './cards.ts'
import type { Card } from './cards.ts'
import { nextUint32 } from './prng.ts'

export function newDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }
  return deck
}

export function shuffle(cards: readonly Card[], state: number): { cards: Card[]; state: number } {
  const shuffled = [...cards]
  let prngState = state
  for (let i = shuffled.length - 1; i >= 1; i--) {
    const next = nextUint32(prngState)
    prngState = next.state
    const j = next.value % (i + 1)
    const swapped = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = swapped
  }
  return { cards: shuffled, state: prngState }
}
