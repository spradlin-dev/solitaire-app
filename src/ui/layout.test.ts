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
  wasteFanPos,
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
      // Zones with vertical extent (real on the side rail) stay on
      // screen, and a drop on the stock or waste never plays to a column
      // in either topology.
      const spots = [layout.stock, layout.waste, ...SUITS.map((suit) => layout.foundations[suit]), wasteFanPos(layout, 2, 3, 3)]
      for (const spot of spots) {
        expect(spot.y - layout.cardHeight / 2).toBeGreaterThanOrEqual(0)
        expect(spot.y + layout.cardHeight / 2).toBeLessThanOrEqual(height)
      }
      expect(dropTargetAt(layout, layout.stock)).toBeNull()
      expect(dropTargetAt(layout, layout.waste)).toBeNull()
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

test('card size never cliffs as the canvas height shrinks, except the one topology seam', () => {
  // One pixel of height must never change the card size noticeably — the
  // budget interpolates instead of stepping. The single exception is the
  // deliberate topology switch, where the top row moves to rails; cards
  // may JUMP BIGGER there, never smaller.
  let previousLayout = computeLayout(900, 840)
  for (let height = 839; height >= 320; height--) {
    const next = computeLayout(900, height)
    if (next.sideRail !== previousLayout.sideRail) {
      expect(next.cardWidth).toBeGreaterThanOrEqual(previousLayout.cardWidth)
    } else {
      expect(Math.abs(next.cardWidth - previousLayout.cardWidth)).toBeLessThan(previousLayout.cardWidth * 0.04)
    }
    previousLayout = next
  }
})

test('the topology flips at most once along a width sweep, and only for a real size win', () => {
  // A one-pixel resize must never rearrange the board for a negligible
  // gain: entering the rail layout has to buy visibly bigger cards.
  let previousLayout = computeLayout(320, 320)
  let flips = 0
  for (let width = 321; width <= 1400; width++) {
    const next = computeLayout(width, 320)
    if (next.sideRail !== previousLayout.sideRail) {
      flips += 1
      expect(next.cardWidth).toBeGreaterThan(previousLayout.cardWidth * 1.05)
    }
    previousLayout = next
  }
  expect(flips).toBeLessThanOrEqual(1)
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
  const step = layout.wasteFanDx
  expect(step).toBeGreaterThan(0)
  expect(layout.wasteFanDy).toBe(0)
  // Five cards in draw 3: the first two sit buried at the base, the last
  // three fan rightward with the playable top card rightmost.
  const xs = [0, 1, 2, 3, 4].map((index) => wasteFanPos(layout, index, 5, 3).x)
  expect(xs).toEqual([base, base, base, base + step, base + 2 * step])
  // Two cards fan as a pair; draw 1 never fans.
  expect(wasteFanPos(layout, 1, 2, 3).x).toBeCloseTo(base + step, 6)
  expect([0, 1, 2].map((index) => wasteFanPos(layout, index, 3, 1).x)).toEqual([base, base, base])
  // The widest fan stays clear of the leftmost foundation in the top-row
  // layouts.
  for (const l of [layout, computeLayout(390, 844)]) {
    const fanRight = wasteFanPos(l, 2, 3, 3).x + l.cardWidth / 2
    expect(fanRight).toBeLessThan(foundationRect(l, 'clubs').x)
  }
})

test('the side-rail layout wins short landscape screens and earns its keep', () => {
  const rail = computeLayout(780, 320)
  expect(rail.sideRail).toBe(true)
  // The whole point: meaningfully bigger cards than the top-row layout
  // could give the same canvas.
  expect(rail.cardWidth).toBeGreaterThan(60)
  // Stock sits above the waste on the left rail; the fan runs downward
  // and stays on screen.
  expect(rail.waste.x).toBeCloseTo(rail.stock.x, 6)
  expect(rail.waste.y).toBeGreaterThan(rail.stock.y)
  expect(rail.wasteFanDx).toBe(0)
  expect(rail.wasteFanDy).toBeGreaterThan(0)
  const fanBottom = wasteFanPos(rail, 2, 3, 3).y + rail.cardHeight / 2
  expect(fanBottom).toBeLessThanOrEqual(320)
  // The foundations form a 2x2 grid inside the canvas.
  for (const suit of SUITS) {
    const f = rail.foundations[suit]
    expect(f.x + rail.cardWidth / 2).toBeLessThanOrEqual(780)
    expect(f.y + rail.cardHeight / 2).toBeLessThanOrEqual(320)
  }
  // Rails never overlap the tableau's drop bands: a drop on the stock,
  // waste, or any foundation resolves to that zone or nothing, never to
  // a column.
  expect(dropTargetAt(rail, rail.stock)).toBeNull()
  expect(dropTargetAt(rail, rail.waste)).toBeNull()
  for (const suit of SUITS) {
    expect(dropTargetAt(rail, rail.foundations[suit])).toEqual({ kind: 'foundation', suit })
  }
  // The worst-case column still fits, compressed, with its margin.
  const bottom = pileCardY(rail, WORST_COLUMN, 18) + rail.cardHeight / 2
  expect(bottom).toBeLessThanOrEqual(320 - 0.1 * rail.cardHeight)
  // Portrait and desktop never see rails.
  expect(computeLayout(390, 844).sideRail).toBe(false)
  expect(computeLayout(1280, 900).sideRail).toBe(false)
})

test('no point inside the stock or waste rects resolves to a tableau drop, in either topology', () => {
  const probes = (rect: Rect) => [
    { x: rect.x + 1, y: rect.y + 1 },
    { x: rect.x + rect.width - 1, y: rect.y + 1 },
    { x: rect.x + 1, y: rect.y + rect.height - 1 },
    // Top-row mode: the bottom edge was the trap (it used to fall inside
    // the tableau band). Rail mode: the RIGHT edge is the trap — only the
    // rail-to-tableau gap separates it from column 0's band.
    { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  ]
  for (const layout of [computeLayout(1280, 900), computeLayout(780, 320)]) {
    for (const rect of [stockRect(layout), wasteRect(layout)]) {
      for (const point of probes(rect)) {
        expect(dropTargetAt(layout, point)).toBeNull()
      }
    }
    // The foundations' left column must likewise never bleed into column
    // 6's band (rail mode puts them side by side).
    const clubs = foundationRect(layout, 'clubs')
    expect(dropTargetAt(layout, { x: clubs.x + 1, y: clubs.y + clubs.height / 2 })).toEqual({
      kind: 'foundation',
      suit: 'clubs',
    })
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
