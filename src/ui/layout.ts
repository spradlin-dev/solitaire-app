import { SUITS } from '../engine/cards.ts'
import type { Suit } from '../engine/cards.ts'

// Pure table geometry: everything the scene needs to place a card comes
// from here, so the math is unit-testable without pixi. All positions are
// card CENTERS (sprites use anchor 0.5); rects are for hit testing.

// True aspect ratio of the vendored Knoll faces (viewBox 167.087 x 242.667).
export const CARD_RATIO = 242.6669922 / 167.0869141

// Below this width the chrome tightens: desktop gutters would burn two
// full card-widths a phone cannot spare.
export const COMPACT_WIDTH = 700

// In card-WIDTH units: [desktop, compact].
const COLUMN_GAP = [0.22, 0.08] as const
const EDGE = [0.35, 0.06] as const
// In card-HEIGHT units: [desktop, compact].
const TOP_MARGIN = [0.3, 0.12] as const
const ROW_GAP = [0.35, 0.18] as const
// Overlap offsets in card-height units.
const FACE_DOWN_OFFSET = 0.16
const FACE_UP_OFFSET = 0.27
// Worst realistic column: 6 face-down plus a 13-card face-up run.
const MAX_COLUMN_HEIGHTS = 1 + 6 * FACE_DOWN_OFFSET + 12 * FACE_UP_OFFSET

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface TableLayout {
  readonly cardWidth: number
  readonly cardHeight: number
  readonly stock: Point
  readonly waste: Point
  readonly foundations: Readonly<Record<Suit, Point>>
  readonly columnXs: readonly number[]
  // Bottom edge of the stock/waste/foundation row: tableau drops resolve
  // only below this line, so a card dropped back onto the waste can never
  // silently play to a column.
  readonly topRowBottom: number
  readonly tableauTop: number
  readonly faceDownOffset: number
  readonly faceUpOffset: number
  // Half the column pitch: bands tile the tableau exactly.
  readonly columnBandHalfWidth: number
  // Horizontal step of the draw-3 waste fan; it extends into the unused
  // slot between the waste and the foundations.
  readonly wasteFanOffset: number
}

export function computeLayout(width: number, height: number): TableLayout {
  const mode = width < COMPACT_WIDTH ? 1 : 0
  const columnGap = COLUMN_GAP[mode]
  const topMargin = TOP_MARGIN[mode]
  const widthInCards = 7 + 6 * columnGap + 2 * EDGE[mode]
  const heightInCards = (topMargin + 1 + ROW_GAP[mode] + MAX_COLUMN_HEIGHTS + topMargin) * CARD_RATIO
  const cardWidth = Math.min(width / widthInCards, height / heightInCards)
  const cardHeight = cardWidth * CARD_RATIO
  const gap = cardWidth * columnGap
  const blockWidth = 7 * cardWidth + 6 * gap
  const left = (width - blockWidth) / 2
  const columnXs = Array.from({ length: 7 }, (_, index) => left + cardWidth / 2 + index * (cardWidth + gap))
  const topRowY = cardHeight * topMargin + cardHeight / 2
  const foundations = {} as Record<Suit, Point>
  SUITS.forEach((suit, index) => {
    foundations[suit] = { x: columnXs[3 + index], y: topRowY }
  })
  return {
    cardWidth,
    cardHeight,
    stock: { x: columnXs[0], y: topRowY },
    waste: { x: columnXs[1], y: topRowY },
    foundations,
    columnXs,
    topRowBottom: topRowY + cardHeight / 2,
    tableauTop: topRowY + cardHeight / 2 + cardHeight * ROW_GAP[mode] + cardHeight / 2,
    faceDownOffset: cardHeight * FACE_DOWN_OFFSET,
    faceUpOffset: cardHeight * FACE_UP_OFFSET,
    columnBandHalfWidth: (cardWidth + gap) / 2,
    wasteFanOffset: cardWidth * 0.28,
  }
}

// Center x of a waste card. Draw 3 fans the last three cards rightward —
// the buried two peek out partially covered, so it is visible that only
// the top card can play. Draw 1 keeps a single stack.
export function wasteFanX(layout: TableLayout, index: number, wasteLength: number, drawCount: 1 | 3): number {
  const fanned = Math.min(drawCount === 3 ? 3 : 1, wasteLength)
  const fanIndex = index - (wasteLength - fanned)
  return layout.waste.x + Math.max(0, fanIndex) * layout.wasteFanOffset
}

// Center y of the card at pileIndex (0-based across face-down then face-up)
// in a column with faceDownCount face-down cards.
export function pileCardY(layout: TableLayout, faceDownCount: number, pileIndex: number): number {
  const downSteps = Math.min(pileIndex, faceDownCount)
  const upSteps = Math.max(0, pileIndex - faceDownCount)
  return layout.tableauTop + downSteps * layout.faceDownOffset + upSteps * layout.faceUpOffset
}

// One owner for card-sized rects; inset < 0 inflates (hint highlights).
export function cardRect(layout: TableLayout, center: Point, inset = 0): Rect {
  return {
    x: center.x - layout.cardWidth / 2 + inset,
    y: center.y - layout.cardHeight / 2 + inset,
    width: layout.cardWidth - 2 * inset,
    height: layout.cardHeight - 2 * inset,
  }
}

export function foundationRect(layout: TableLayout, suit: Suit): Rect {
  return cardRect(layout, layout.foundations[suit])
}

export function stockRect(layout: TableLayout): Rect {
  return cardRect(layout, layout.stock)
}

export function wasteRect(layout: TableLayout): Rect {
  return cardRect(layout, layout.waste)
}

export function inRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  )
}

// Drop resolution: a point over a foundation rect targets that foundation;
// otherwise a point inside a column's x-band below the top row targets that
// column. Returns null when the point is over nothing droppable.
export type DropTarget = { readonly kind: 'foundation'; readonly suit: Suit } | { readonly kind: 'tableau'; readonly index: number }

export function dropTargetAt(layout: TableLayout, point: Point): DropTarget | null {
  for (const suit of SUITS) {
    if (inRect(point, foundationRect(layout, suit))) return { kind: 'foundation', suit }
  }
  if (point.y > layout.topRowBottom) {
    for (let index = 0; index < 7; index++) {
      if (Math.abs(point.x - layout.columnXs[index]) <= layout.columnBandHalfWidth) {
        return { kind: 'tableau', index }
      }
    }
  }
  return null
}
