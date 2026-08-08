export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const

export type Rank = (typeof RANKS)[number]

export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const

export type Suit = (typeof SUITS)[number]

export interface Card {
  readonly rank: Rank
  readonly suit: Suit
}

export function cardKey(card: Card): string {
  return `${card.rank}:${card.suit}`
}
