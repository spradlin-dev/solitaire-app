import { expect, test } from 'vitest'
import fc from 'fast-check'
import {
  BUDGET_FULL_HEIGHT,
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

const WORST_COLUMN = { faceDown: 6, faceUp: 13 }

const arbCanvas = fc.record({
  width: fc.integer({ min: 320, max: 4000 }),
  // Biased so short (landscape-phone) heights appear in every run, not in
  // one of twenty samples.
  height: fc.oneof(fc.integer({ min: 320, max: 4000 }), fc.integer({ min: 320, max: 519 })),
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
      // The tallest possible column fits WITH a bottom margin — asserting
      // the margin (not just <= height) catches a dropped term in the
      // tableauSpan formula that mere fitting would forgive.
      const bottom = pileCardY(layout, WORST_COLUMN, 18) + layout.cardHeight / 2
      expect(bottom).toBeLessThanOrEqual(height - 0.1 * layout.cardHeight)
      // At full-budget heights the worst case is reserved outright: the
      // walk is the plain uncompressed one. This pins the reservation
      // path, which compression would otherwise make untestable.
      if (height >= BUDGET_FULL_HEIGHT) {
        expect(pileCardY(layout, WORST_COLUMN, 18)).toBeCloseTo(
          layout.tableauTop + 6 * layout.faceDownOffset + 12 * layout.faceUpOffset,
          6,
        )
      }
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
  const counts = { faceDown: 2, faceUp: 2 }
  expect(pileCardY(layout, counts, 0)).toBe(layout.tableauTop)
  expect(pileCardY(layout, counts, 1)).toBeCloseTo(layout.tableauTop + layout.faceDownOffset, 6)
  expect(pileCardY(layout, counts, 2)).toBeCloseTo(layout.tableauTop + 2 * layout.faceDownOffset, 6)
  expect(pileCardY(layout, counts, 3)).toBeCloseTo(layout.tableauTop + 2 * layout.faceDownOffset + layout.faceUpOffset, 6)
  // Face-up cards overlap more loosely than face-down ones.
  expect(layout.faceUpOffset).toBeGreaterThan(layout.faceDownOffset)
  // An empty column's slot sits exactly at the tableau top.
  expect(pileCardY(layout, { faceDown: 0, faceUp: 0 }, 0)).toBe(layout.tableauTop)
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
  expect(pileCardY(compact, WORST_COLUMN, 18) + compact.cardHeight / 2).toBeLessThanOrEqual(844)
})

test('a short landscape screen gets playable card sizes', () => {
  const short = computeLayout(780, 320)
  // The concrete claim behind "looks good in landscape": cards stay above
  // a hard readability floor at a typical phone-landscape canvas.
  expect(short.cardWidth).toBeGreaterThan(45)
  // And the worst-case column still fits, via compression.
  expect(pileCardY(short, WORST_COLUMN, 18) + short.cardHeight / 2).toBeLessThanOrEqual(320)
})

test('card size never cliffs as the canvas height shrinks through the budget band', () => {
  // One pixel of height must never change the card size noticeably — the
  // budget interpolates instead of stepping.
  let previous = computeLayout(900, 840).cardWidth
  for (let height = 839; height >= 320; height--) {
    const next = computeLayout(900, height).cardWidth
    expect(Math.abs(next - previous)).toBeLessThan(previous * 0.04)
    previous = next
  }
})

test('tall columns compress their overlaps in order; short piles are untouched', () => {
  const short = computeLayout(780, 320)
  const ys = Array.from({ length: 19 }, (_, index) => pileCardY(short, WORST_COLUMN, index))
  for (let i = 1; i < ys.length; i++) {
    expect(ys[i]).toBeGreaterThan(ys[i - 1])
  }
  expect(ys[18] + short.cardHeight / 2).toBeLessThanOrEqual(320)
  // A pile that fits naturally keeps the plain uncompressed walk.
  const counts = { faceDown: 2, faceUp: 2 }
  expect(pileCardY(short, counts, 3)).toBeCloseTo(short.tableauTop + 2 * short.faceDownOffset + short.faceUpOffset, 6)
})

test('compression never hides the rank glyph: the squeezed step keeps the corner index visible', () => {
  // The vendored faces draw the rank glyph in the top ~12% of the card
  // and the suit pip down to ~25%. The worst-case squeeze must keep at
  // least the rank visible, or buried run cards become unidentifiable.
  // This pins the floor so a future budget retune trips a test instead
  // of silently clipping the art.
  const short = computeLayout(780, 320)
  const step = pileCardY(short, WORST_COLUMN, 8) - pileCardY(short, WORST_COLUMN, 7)
  expect(step).toBeGreaterThan(0.12 * short.cardHeight)
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
