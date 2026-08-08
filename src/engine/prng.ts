// mulberry32. State is a plain uint32 threaded by the caller — a pure
// function with no hidden globals, so shuffles are reproducible and
// testable. (Klondike itself never reshuffles; only the deal consumes it.)
export function nextUint32(state: number): { value: number; state: number } {
  const advanced = (state + 0x6d2b79f5) | 0
  let t = Math.imul(advanced ^ (advanced >>> 15), 1 | advanced)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { value: (t ^ (t >>> 14)) >>> 0, state: advanced >>> 0 }
}
