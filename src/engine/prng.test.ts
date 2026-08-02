import { expect, test } from 'vitest'
import { nextUint32 } from './prng.ts'

// Golden fixtures computed with the canonical mulberry32 reference
// implementation, independently of src/engine/prng.ts.
const STREAM_SEED_42 = [2581720956, 1925393290, 3661312704, 2876485805, 750819978]
const STREAM_SEED_DEADBEEF = [4043151706, 1147597007, 3315858022, 1538288752, 2042435954]

function stream(seed: number, count: number): number[] {
  const values: number[] = []
  let state = seed
  for (let i = 0; i < count; i++) {
    const next = nextUint32(state)
    values.push(next.value)
    state = next.state
  }
  return values
}

test('seed 42 produces the reference mulberry32 stream', () => {
  expect(stream(42, 5)).toEqual(STREAM_SEED_42)
})

test('seed 0xDEADBEEF produces the reference mulberry32 stream', () => {
  expect(stream(0xdeadbeef, 5)).toEqual(STREAM_SEED_DEADBEEF)
})

test('nextUint32 is pure: same state in, same result out', () => {
  expect(nextUint32(42)).toEqual(nextUint32(42))
})
