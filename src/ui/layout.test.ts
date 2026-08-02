import { expect, test } from 'vitest'
import fc from 'fast-check'
import {
  CARD_RATIO,
  computeLayout,
  dropTargetAt,
  foundationRect,
  inRect,
  pileCardY,
  stockRect,
  wasteFanX,
  wasteRect,
} from './layout.ts'
import type { Rect } from './layout.ts'
import { SUITS } from '../engine/cards.ts'

const arbCanvas = fc.record({
  width: fc.integer({ min: 320, max: 4000 }),
  height: fc.integer({ min: 320, max: 4000 }),
})

test('every zone fits inside the canvas at any size', () => {
  fc.assert(
    fc.property(arbCanvas, ({ width, height }) => {
      const layout = computeLayout(width, height)
      expect(layout.cardWidth).toBeGreaterThan(0)
      expect(layout.cardHeight / layout.cardWidth).toBeCloseTo(CARD_RATIO, 6)
      const xs = [layout.stock.x, layout.waste.x, ...SUITS.map((suit) => layout.foundations[suit].x), ...layout.columnXs]
      for (const x of xs) {
        expect(x - layout.cardWidth / 2).toBeGreaterThanOrEqual(0)
        expect(x + layout.cardWidth / 2).toBeLessThanOrEqual(width)
      }
      // The tallest possible column (6 face-down + a 13-card run) fits.
      const bottom = pileCardY(layout, 6, 18) + layout.cardHeight / 2
      expect(bottom).toBeLessThanOrEqual(height)
    }),
    { numRuns: 60 },
  )
})

test('columns are evenly spaced left to right and clear of each other', () => {
  const layout = computeLayout(1280, 900)
  for (let i = 1; i < 7; i++) {
    const spacing = layout.columnXs[i] - layout.columnXs[i - 1]
    expect(spacing).toBeGreaterThan(layout.cardWidth)
    expect(spacing).toBeCloseTo(layout.columnXs[1] - layout.columnXs[0], 6)
  }
})

test('pile card y walks face-down offsets then face-up offsets', () => {
  const layout = computeLayout(1280, 900)
  expect(pileCardY(layout, 2, 0)).toBe(layout.tableauTop)
  expect(pileCardY(layout, 2, 1)).toBeCloseTo(layout.tableauTop + layout.faceDownOffset, 6)
  expect(pileCardY(layout, 2, 2)).toBeCloseTo(layout.tableauTop + 2 * layout.faceDownOffset, 6)
  expect(pileCardY(layout, 2, 3)).toBeCloseTo(layout.tableauTop + 2 * layout.faceDownOffset + layout.faceUpOffset, 6)
  // Face-up cards overlap more loosely than face-down ones.
  expect(layout.faceUpOffset).toBeGreaterThan(layout.faceDownOffset)
})

test('drop targets resolve foundations first, then column bands, then nothing', () => {
  const layout = computeLayout(1280, 900)
  expect(dropTargetAt(layout, layout.foundations.hearts)).toEqual({ kind: 'foundation', suit: 'hearts' })
  expect(dropTargetAt(layout, { x: layout.columnXs[3], y: layout.tableauTop + layout.cardHeight })).toEqual({
    kind: 'tableau',
    index: 3,
  })
  // The stock corner is neither a foundation nor a column drop.
  expect(dropTargetAt(layout, { x: layout.stock.x, y: layout.stock.y })).toBeNull()
  expect(dropTargetAt(layout, { x: 1, y: 1 })).toBeNull()
})

test('zone rects agree with their centers', () => {
  const layout = computeLayout(1280, 900)
  expect(inRect(layout.stock, stockRect(layout))).toBe(true)
  for (const suit of SUITS) {
    expect(inRect(layout.foundations[suit], foundationRect(layout, suit))).toBe(true)
  }
})

test('compact mode gives a phone meaningfully bigger cards than desktop spacing would', () => {
  const compact = computeLayout(390, 844)
  // Desktop spacing packs 9.02 card-widths across; compact packs 7.6.
  expect(compact.cardWidth).toBeGreaterThan((390 / 9.02) * 1.15)
  // The whole board still fits.
  expect(pileCardY(compact, 6, 18) + compact.cardHeight / 2).toBeLessThanOrEqual(844)
})

test('draw 3 fans the last three waste cards; draw 1 stacks them', () => {
  const layout = computeLayout(1280, 900)
  const base = layout.waste.x
  const step = layout.wasteFanOffset
  expect(step).toBeGreaterThan(0)
  // Five cards in draw 3: the first two sit buried at the base, the last
  // three fan rightward with the playable top card rightmost.
  const xs = [0, 1, 2, 3, 4].map((index) => wasteFanX(layout, index, 5, 3))
  expect(xs).toEqual([base, base, base, base + step, base + 2 * step])
  // Two cards fan as a pair; draw 1 never fans.
  expect(wasteFanX(layout, 1, 2, 3)).toBeCloseTo(base + step, 6)
  expect([0, 1, 2].map((index) => wasteFanX(layout, index, 3, 1))).toEqual([base, base, base])
  // The widest fan stays clear of the leftmost foundation in both modes.
  for (const l of [layout, computeLayout(390, 844)]) {
    const fanRight = wasteFanX(l, 2, 3, 3) + l.cardWidth / 2
    expect(fanRight).toBeLessThan(foundationRect(l, 'clubs').x)
  }
})

test('no point inside the stock or waste rects resolves to a tableau drop', () => {
  const layout = computeLayout(1280, 900)
  const probes = (rect: Rect) => [
    { x: rect.x + 1, y: rect.y + 1 },
    { x: rect.x + rect.width - 1, y: rect.y + 1 },
    { x: rect.x + 1, y: rect.y + rect.height - 1 },
    // The bottom edge was the trap: it used to fall inside the tableau band.
    { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  ]
  for (const rect of [stockRect(layout), wasteRect(layout)]) {
    for (const point of probes(rect)) {
      expect(dropTargetAt(layout, point)).toBeNull()
    }
  }
})

test('column bands tile the tableau area: gutters resolve, the outside does not', () => {
  // Both spacing modes carry the same guarantees.
  for (const layout of [computeLayout(1280, 900), computeLayout(390, 844)]) {
    const y = layout.tableauTop + layout.cardHeight
    for (let i = 0; i < 6; i++) {
      // A hair to each side of the exact midpoint (the midpoint itself can
      // fall into a one-ulp float seam between the two bands).
      const mid = (layout.columnXs[i] + layout.columnXs[i + 1]) / 2
      expect(dropTargetAt(layout, { x: mid - 0.001, y })).toEqual({ kind: 'tableau', index: i })
      expect(dropTargetAt(layout, { x: mid + 0.001, y })).toEqual({ kind: 'tableau', index: i + 1 })
    }
    expect(dropTargetAt(layout, { x: layout.columnXs[0] - layout.columnBandHalfWidth - 1, y })).toBeNull()
    expect(dropTargetAt(layout, { x: layout.columnXs[6] + layout.columnBandHalfWidth + 1, y })).toBeNull()
  }
})
