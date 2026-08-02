import { expect, test } from 'vitest'
import { formatDealFragment, parseDealFragment } from './dealLink.ts'

test('a formatted deal link round-trips through the parser in both modes', () => {
  expect(parseDealFragment(formatDealFragment({ seed: 0, drawCount: 1 }))).toEqual({ seed: 0, drawCount: 1 })
  expect(parseDealFragment(formatDealFragment({ seed: 12345, drawCount: 3 }))).toEqual({ seed: 12345, drawCount: 3 })
  expect(parseDealFragment(formatDealFragment({ seed: 0xffffffff, drawCount: 1 }))).toEqual({
    seed: 0xffffffff,
    drawCount: 1,
  })
})

test('the leading hash is optional', () => {
  expect(parseDealFragment('deal=7.3')).toEqual({ seed: 7, drawCount: 3 })
  expect(parseDealFragment('#deal=7.3')).toEqual({ seed: 7, drawCount: 3 })
})

test('formatting an invalid seed throws instead of emitting a link the parser rejects', () => {
  expect(() => formatDealFragment({ seed: 1.5, drawCount: 3 })).toThrow('invalid seed')
  expect(() => formatDealFragment({ seed: -1, drawCount: 1 })).toThrow('invalid seed')
  expect(() => formatDealFragment({ seed: 0x100000000, drawCount: 1 })).toThrow('invalid seed')
})

test('malformed fragments parse to null', () => {
  for (const bad of [
    '',
    '#deal=',
    '#deal=12',
    '#deal=12.',
    '#deal=12.2',
    '#deal=abc.1',
    '#deal=12.34.1',
    '#deal=-5.1',
    '#deal=1.1x',
    '#deal=4294967296.1',
    '#other=1.1',
    'deal=1.1 ',
  ]) {
    expect(parseDealFragment(bad), bad).toBeNull()
  }
})
