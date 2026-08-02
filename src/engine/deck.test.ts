import { expect, test } from 'vitest'
import { newDeck, shuffle } from './deck.ts'
import { RANKS, SUITS, cardKey } from './cards.ts'

// Golden fixture computed with the canonical mulberry32 reference and a
// textbook Fisher-Yates (j = value % (i + 1), i from 51 down to 1) over
// the canonical clubs/diamonds/hearts/spades x A..K deck, independently
// of src/engine/deck.ts.
// prettier-ignore
const SHUFFLED_SEED_42 = [
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
