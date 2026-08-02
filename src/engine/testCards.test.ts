import { expect, test } from 'vitest'
import { cards } from './testCards.ts'

test('a bad card spec fails loudly at the fixture, naming the typo', () => {
  expect(() => cards('T:clubs')).toThrow('bad card spec: "T:clubs"')
  expect(() => cards('7:spade')).toThrow('bad card spec: "7:spade"')
  expect(() => cards('A:clubs', 'Jclubs')).toThrow('bad card spec: "Jclubs"')
})
