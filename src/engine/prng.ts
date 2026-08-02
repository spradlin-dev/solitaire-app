// mulberry32. State is a plain uint32 threaded by the caller, so it can
// live inside engine state and make redeals replay deterministically.
export function nextUint32(state: number): { value: number; state: number } {
  const advanced = (state + 0x6d2b79f5) | 0
  let t = Math.imul(advanced ^ (advanced >>> 15), 1 | advanced)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { value: (t ^ (t >>> 14)) >>> 0, state: advanced >>> 0 }
}
