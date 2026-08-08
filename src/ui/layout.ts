import { SUITS } from '../engine/cards.ts'
import type { Suit } from '../engine/cards.ts'

// Pure table geometry: everything the scene needs to place a card comes
// from here, so the math is unit-testable without pixi. All positions are
// card CENTERS (sprites use anchor 0.5); rects are for hit testing.

// True aspect ratio of the vendored Knoll faces (viewBox 167.087 x 242.667).
export const CARD_RATIO = 242.6669922 / 167.0869141

// Below this width the horizontal chrome tightens: desktop gutters would
// burn two full card-widths a phone cannot spare.
export const COMPACT_WIDTH = 700
// The vertical chrome and the tableau height budget slide between these
// heights: at or above the top, roomy margins and the worst-case column
// reserved outright (no compression ever); at or below the bottom, tight
// margins and only the short budget, with tall columns compressing
// (pileCardY). Interpolating keeps card size continuous — no cliff when a
// window crosses a single pixel of height.
export const BUDGET_FULL_HEIGHT = 800
const BUDGET_SHORT_HEIGHT = 400
// Below this height a landscape canvas may swap topology: the top row
// moves to side rails (stock/waste left, foundations in a 2x2 block
// right) so the tableau gets the full height. The rail layout is used
// only when it actually yields bigger cards than the top-row layout.
// index.css's banner-anchoring media query approximates this same
// threshold — retune them together.
export const SIDE_RAIL_HEIGHT = 520
// Side-rail spacing, in card units: rail-to-tableau gap (widths), the
// vertical gap between rail cards (heights), and the waste's downward
// fan step (heights — shows the buried cards' rank corner).
const RAIL_GAP = 0.3
const RAIL_STACK_GAP = 0.12
const RAIL_FAN_STEP = 0.24
const FOUNDATION_GRID_GAP = 0.08

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
// The interpolation floor: a typical column (6 face-down plus a 5-card
// run); anything taller squeezes its overlaps to fit.
const SHORT_COLUMN_HEIGHTS = 1 + 6 * FACE_DOWN_OFFSET + 4 * FACE_UP_OFFSET

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
  // Tableau drops resolve only below this line. Under the top row it is
  // the row's bottom edge, so a card dropped back onto the waste can
  // never silently play to a column; on side rails the columns start at
  // the top and this is only a sliver — there the stock, waste, and
  // foundations stay out of the drop bands horizontally instead.
  readonly tableauDropTop: number
  readonly tableauTop: number
  readonly faceDownOffset: number
  readonly faceUpOffset: number
  // Half the column pitch: bands tile the tableau exactly.
  readonly columnBandHalfWidth: number
  // Waste fan step per fanned card: rightward under the top row,
  // downward on the side rail.
  readonly wasteFanDx: number
  readonly wasteFanDy: number
  // Vertical room below tableauTop for a column's overlap offsets; a
  // column whose natural extent exceeds it compresses (pileCardY).
  readonly tableauSpan: number
  // True when the top row lives on side rails (short landscape screens).
  readonly sideRail: boolean
}

// The shared height interpolation (see BUDGET_FULL_HEIGHT above).
function verticalTuning(height: number): { columnBudget: number; topMargin: number; rowGap: number } {
  const tall = Math.min(1, Math.max(0, (height - BUDGET_SHORT_HEIGHT) / (BUDGET_FULL_HEIGHT - BUDGET_SHORT_HEIGHT)))
  return {
    columnBudget: SHORT_COLUMN_HEIGHTS + (MAX_COLUMN_HEIGHTS - SHORT_COLUMN_HEIGHTS) * tall,
    topMargin: TOP_MARGIN[1] + (TOP_MARGIN[0] - TOP_MARGIN[1]) * tall,
    rowGap: ROW_GAP[1] + (ROW_GAP[0] - ROW_GAP[1]) * tall,
  }
}

function topRowLayout(width: number, height: number): TableLayout {
  const hMode = width < COMPACT_WIDTH ? 1 : 0
  const { columnBudget, topMargin, rowGap } = verticalTuning(height)
  const columnGap = COLUMN_GAP[hMode]
  const widthInCards = 7 + 6 * columnGap + 2 * EDGE[hMode]
  const heightInCards = (topMargin + 1 + rowGap + columnBudget + topMargin) * CARD_RATIO
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
  const tableauTop = topRowY + cardHeight / 2 + cardHeight * rowGap + cardHeight / 2
  return {
    cardWidth,
    cardHeight,
    stock: { x: columnXs[0], y: topRowY },
    waste: { x: columnXs[1], y: topRowY },
    foundations,
    columnXs,
    tableauDropTop: topRowY + cardHeight / 2,
    tableauTop,
    faceDownOffset: cardHeight * FACE_DOWN_OFFSET,
    faceUpOffset: cardHeight * FACE_UP_OFFSET,
    columnBandHalfWidth: (cardWidth + gap) / 2,
    wasteFanDx: cardWidth * 0.28,
    wasteFanDy: 0,
    // At least (columnBudget - 1) card-heights by construction: exactly
    // the room the sizing formula reserved below the first card.
    tableauSpan: height - tableauTop - cardHeight / 2 - cardHeight * topMargin,
    sideRail: false,
  }
}

function sideRailLayout(width: number, height: number): TableLayout {
  const { columnBudget, topMargin } = verticalTuning(height)
  // Rails always use the compact horizontal chrome: a short screen never
  // has width to burn on desktop gutters.
  const columnGap = COLUMN_GAP[1]
  const widthInCards =
    2 * EDGE[1] + 1 + RAIL_GAP + 7 + 6 * columnGap + RAIL_GAP + 2 + FOUNDATION_GRID_GAP
  // No top row above the tableau: the first card plus the column budget
  // is the whole vertical story.
  const heightInCards = (topMargin + columnBudget + topMargin) * CARD_RATIO
  const cardWidth = Math.min(width / widthInCards, height / heightInCards)
  const cardHeight = cardWidth * CARD_RATIO
  const gap = cardWidth * columnGap
  // A wide-but-short canvas would otherwise pool all its slack into one
  // gulf between the tableau and the foundations: each rail gap may grow
  // by up to a card-width, and the rest centers the whole assembly.
  const slack = Math.max(0, width - widthInCards * cardWidth)
  const gapGrow = Math.min(slack / 2, cardWidth)
  const shift = (slack - 2 * gapGrow) / 2
  const railTopY = cardHeight * topMargin + cardHeight / 2
  const leftRailX = shift + (EDGE[1] + 0.5) * cardWidth
  const tableauLeft = shift + (EDGE[1] + 1 + RAIL_GAP) * cardWidth + gapGrow
  const columnXs = Array.from({ length: 7 }, (_, index) => tableauLeft + cardWidth / 2 + index * (cardWidth + gap))
  const gridX0 = width - shift - (EDGE[1] + 2 + FOUNDATION_GRID_GAP) * cardWidth + cardWidth / 2
  const gridX1 = gridX0 + (1 + FOUNDATION_GRID_GAP) * cardWidth
  const gridY1 = railTopY + (1 + RAIL_STACK_GAP) * cardHeight
  const foundations = {} as Record<Suit, Point>
  const gridSpots = [
    { x: gridX0, y: railTopY },
    { x: gridX1, y: railTopY },
    { x: gridX0, y: gridY1 },
    { x: gridX1, y: gridY1 },
  ]
  SUITS.forEach((suit, index) => {
    foundations[suit] = gridSpots[index]
  })
  const tableauTop = railTopY
  return {
    cardWidth,
    cardHeight,
    stock: { x: leftRailX, y: railTopY },
    waste: { x: leftRailX, y: railTopY + (1 + RAIL_STACK_GAP) * cardHeight },
    foundations,
    columnXs,
    // Nothing sits above the columns; only a sliver above the first card
    // is dead space for drops.
    tableauDropTop: tableauTop - cardHeight / 2 - cardHeight * 0.06,
    tableauTop,
    faceDownOffset: cardHeight * FACE_DOWN_OFFSET,
    faceUpOffset: cardHeight * FACE_UP_OFFSET,
    columnBandHalfWidth: (cardWidth + gap) / 2,
    wasteFanDx: 0,
    wasteFanDy: cardHeight * RAIL_FAN_STEP,
    tableauSpan: height - tableauTop - cardHeight / 2 - cardHeight * topMargin,
    sideRail: true,
  }
}

export function computeLayout(width: number, height: number): TableLayout {
  const topRow = topRowLayout(width, height)
  if (height >= SIDE_RAIL_HEIGHT) return topRow
  const rail = sideRailLayout(width, height)
  // The rail must EARN the swap: rearranging the whole board for a sliver
  // of card size would churn the topology on a one-pixel resize.
  return rail.cardWidth > topRow.cardWidth * 1.08 ? rail : topRow
}

// Center of a waste card. Draw 3 fans the last three cards along the
// layout's fan direction (rightward under the top row, downward on the
// side rail) — the buried two peek out partially covered, so it is
// visible that only the top card can play. Draw 1 keeps a single stack.
export function wasteFanPos(layout: TableLayout, index: number, wasteLength: number, drawCount: 1 | 3): Point {
  const fanned = Math.min(drawCount === 3 ? 3 : 1, wasteLength)
  const fanIndex = Math.max(0, index - (wasteLength - fanned))
  return {
    x: layout.waste.x + fanIndex * layout.wasteFanDx,
    y: layout.waste.y + fanIndex * layout.wasteFanDy,
  }
}

// The column's card counts, passed as one unit so they can never be
// transposed with each other or the pile index (all are numbers).
interface PileCounts {
  readonly faceDown: number
  readonly faceUp: number
}

// Center y of the card at pileIndex (0-based across face-down then
// face-up) in a column holding `counts` cards. A column too tall for the
// room below tableauTop squeezes its overlaps evenly, like fanning cards
// tighter on a small table — so every card stays on screen at any canvas
// height.
export function pileCardY(layout: TableLayout, counts: PileCounts, pileIndex: number): number {
  const lastIndex = Math.max(0, counts.faceDown + counts.faceUp - 1)
  const natural =
    Math.min(lastIndex, counts.faceDown) * layout.faceDownOffset +
    Math.max(0, lastIndex - counts.faceDown) * layout.faceUpOffset
  const squeeze = natural > layout.tableauSpan ? layout.tableauSpan / natural : 1
  const downSteps = Math.min(pileIndex, counts.faceDown)
  const upSteps = Math.max(0, pileIndex - counts.faceDown)
  return layout.tableauTop + (downSteps * layout.faceDownOffset + upSteps * layout.faceUpOffset) * squeeze
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
// otherwise a point inside a column's x-band below tableauDropTop targets
// that column. Returns null when the point is over nothing droppable.
type DropTarget = { readonly kind: 'foundation'; readonly suit: Suit } | { readonly kind: 'tableau'; readonly index: number }

export function dropTargetAt(layout: TableLayout, point: Point): DropTarget | null {
  for (const suit of SUITS) {
    if (inRect(point, foundationRect(layout, suit))) return { kind: 'foundation', suit }
  }
  if (point.y > layout.tableauDropTop) {
    for (let index = 0; index < 7; index++) {
      if (Math.abs(point.x - layout.columnXs[index]) <= layout.columnBandHalfWidth) {
        return { kind: 'tableau', index }
      }
    }
  }
  return null
}
