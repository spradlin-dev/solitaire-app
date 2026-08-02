import { expect, test } from 'vitest'
import { newDeck, shuffle } from './deck.ts'
import { RANKS, SUITS, cardKey } from './cards.ts'
import { SHUFFLED_SEED_42 } from './testCards.ts'

const STATE_AFTER_SHUFFLE_42 = 3215543289

test('a new deck holds all 52 rank-suit combinations exactly once', () => {
  const deck = newDeck()
  expect(deck).toHaveLength(52)
  const seen = new Set(deck.map(cardKey))
  expect(seen.size).toBe(52)
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      expect(seen.has(`${rank}:${suit}`)).toBe(true)
    }
  }
})

test('shuffling a new deck with seed 42 gives the reference Fisher-Yates order', () => {
  const result = shuffle(newDeck(), 42)
  expect(result.cards.map(cardKey)).toEqual(SHUFFLED_SEED_42)
  expect(result.state).toBe(STATE_AFTER_SHUFFLE_42)
})

test('shuffle does not mutate the deck it is given', () => {
  const deck = newDeck()
  const before = deck.map(cardKey)
  shuffle(deck, 42)
  expect(deck.map(cardKey)).toEqual(before)
})
