import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js'
import type { FederatedPointerEvent, Texture } from 'pixi.js'
import { cardAssetUrl } from '../cardAssets.ts'
import { CARD_RATIO, cardRect, computeLayout, dropTargetAt, pileCardY, wasteFanPos } from './layout.ts'
import type { Point, Rect, TableLayout } from './layout.ts'
import { newDeck } from '../engine/deck.ts'
import { SUITS, cardKey } from '../engine/cards.ts'
import type { Card, Suit } from '../engine/cards.ts'
import type { KlondikeAction, KlondikeState, Zone } from '../engine/klondike.ts'
import type { TapSpot } from '../engine/helpers.ts'
import type { GameSnapshot } from '../store.ts'

// The scene owns sprites and geometry; the store owns truth. update()
// retargets a persistent 52-sprite graph from the snapshot — sprites are
// never rebuilt, so tweens can carry cards between positions.

// The canvas mount captures this module in a closure; a hot update would
// leave that stale closure rendering old code, so reload outright.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}

const TWEEN_MS = 180
// A card in flight is lifted off the table: its tween renders in a band
// above every resting card and settles to its final z on landing, exactly
// like a real hand lifting a card over the ones left lying there.
const LIFT_Z = 600
const DRAG_Z = 1500
const DRAG_THRESHOLD_PX = 8
// How long a drag survives buttonless pointermoves before snapping home.
// A real release often arrives as move(buttons=0) THEN pointerup within a
// frame — macOS trackpads coalesce the final glide past the finger lift —
// so aborting on the first such move eats every trackpad drop. Only a
// SUSTAINED buttonless hover means the release itself was never delivered.
const STALE_RELEASE_MS = 250
const DOUBLE_TAP_MS = 350
const HINT_MS = 900
const HINT_TINT = 0xffd54a
const BACK_COLOR = 0xa63d40
const OUTLINE_COLOR = 0xffffff

export interface SceneHandlers {
  // Returns whether the store accepted the action; a refused drop snaps back.
  onAction(action: KlondikeAction): boolean
  onTap(spot: TapSpot): void
}

export interface TableScene {
  update(snapshot: GameSnapshot): void
  flashHint(action: KlondikeAction): void
  destroy(): void
}

interface CardNode {
  readonly container: Container
  readonly faceSprite: Sprite
  readonly backSprite: Sprite
  readonly card: Card
}

// Where a card currently sits, from the scene's point of view — enough to
// begin a drag or a tap without re-deriving anything from pixi state.
// Stock cards have no engine zone (the stock is not a move source), so
// their zone is null and they are never draggable.
interface CardPlace {
  readonly zone: Zone | null
  readonly pileIndex: number
  readonly faceUpIndex: number
  readonly draggable: boolean
}

function backTexture(app: Application): Texture {
  const w = 167 * 2
  const h = Math.round(w * CARD_RATIO)
  const g = new Graphics()
  // Classic nested-pinstripe back: unmistakably not a face, and immune to
  // the overdraw artifacts a free-hand lattice showed in review.
  g.roundRect(0, 0, w, h, 16).fill(0xffffff)
  g.roundRect(10, 10, w - 20, h - 20, 10).fill(BACK_COLOR)
  g.roundRect(24, 24, w - 48, h - 48, 8).stroke({ color: 0xc76a6c, width: 4 })
  g.roundRect(38, 38, w - 76, h - 76, 6).stroke({ color: 0xc76a6c, width: 2 })
  const texture = app.renderer.generateTexture(g)
  g.destroy()
  return texture
}

const SUIT_GLYPHS: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }

export async function createTableScene(app: Application, handlers: SceneHandlers): Promise<TableScene> {
  const deck = newDeck()
  const faces = new Map<string, Texture>()
  await Promise.all(
    deck.map(async (card) => {
      faces.set(cardKey(card), await Assets.load<Texture>(cardAssetUrl(card)))
    }),
  )
  const back = backTexture(app)

  const root = new Container()
  root.sortableChildren = true
  app.stage.addChild(root)
  // The scene takes ownership of the stage for its lifetime; TableCanvas
  // destroys the whole Application right after destroy(), so nothing is
  // restored here.
  app.stage.eventMode = 'static'
  app.stage.hitArea = app.screen

  const outlines = new Graphics()
  outlines.zIndex = 0
  root.addChild(outlines)
  const glyphs: Text[] = []

  const stockZone = new Graphics()
  stockZone.zIndex = 1
  stockZone.eventMode = 'static'
  stockZone.cursor = 'pointer'
  root.addChild(stockZone)

  const hintOverlay = new Graphics()
  hintOverlay.zIndex = 2000
  root.addChild(hintOverlay)

  const nodes = new Map<string, CardNode>()
  for (const card of deck) {
    const container = new Container()
    const faceSprite = new Sprite(faces.get(cardKey(card))!)
    faceSprite.anchor.set(0.5)
    const backSprite = new Sprite(back)
    backSprite.anchor.set(0.5)
    container.addChild(backSprite, faceSprite)
    root.addChild(container)
    nodes.set(cardKey(card), { container, faceSprite, backSprite, card })
  }

  let layout: TableLayout = computeLayout(app.screen.width, app.screen.height)
  let last: GameSnapshot | null = null
  const places = new Map<string, CardPlace>()

  // --- tweens ---
  interface Tween {
    readonly node: Container
    readonly fromX: number
    readonly fromY: number
    readonly toX: number
    readonly toY: number
    // Restored when the flight lands; in the air the node sits at
    // LIFT_Z + finalZ so simultaneous flights keep their landing order.
    readonly finalZ: number
    elapsed: number
  }
  const tweens = new Map<Container, Tween>()
  let hintElapsed: number | null = null

  function tweenTo(node: Container, target: Point, instant: boolean, finalZ: number): void {
    if (instant || (Math.abs(node.x - target.x) < 0.5 && Math.abs(node.y - target.y) < 0.5)) {
      tweens.delete(node)
      node.position.set(target.x, target.y)
      node.zIndex = finalZ
      return
    }
    node.zIndex = LIFT_Z + finalZ
    tweens.set(node, { node, fromX: node.x, fromY: node.y, toX: target.x, toY: target.y, finalZ, elapsed: 0 })
  }

  function tick(): void {
    const dt = app.ticker.deltaMS
    for (const tween of [...tweens.values()]) {
      tween.elapsed += dt
      const t = Math.min(1, tween.elapsed / TWEEN_MS)
      const ease = 1 - (1 - t) ** 3
      tween.node.position.set(
        tween.fromX + (tween.toX - tween.fromX) * ease,
        tween.fromY + (tween.toY - tween.fromY) * ease,
      )
      if (t >= 1) {
        tween.node.zIndex = tween.finalZ
        tweens.delete(tween.node)
      }
    }
    if (hintElapsed !== null) {
      hintElapsed += dt
      if (hintElapsed >= HINT_MS) clearHint()
      else hintOverlay.alpha = 1 - hintElapsed / HINT_MS
    }
    if (drag !== null && drag.staleSince !== null && performance.now() - drag.staleSince > STALE_RELEASE_MS) {
      abortDrag()
    }
  }
  app.ticker.add(tick)

  function clearHint(): void {
    hintElapsed = null
    hintOverlay.clear()
    hintOverlay.alpha = 1
    for (const node of nodes.values()) {
      node.faceSprite.tint = 0xffffff
    }
  }

  // --- static table furniture ---
  // Rebuilt only on resize; the sole per-snapshot bit is the recycle
  // glyph's visibility, handled in applySnapshot.
  let recycleGlyph: Text | null = null

  function roundedRect(target: Graphics, rect: Rect, radius: number): Graphics {
    return target.roundRect(rect.x, rect.y, rect.width, rect.height, radius)
  }

  function rebuildFurniture(): void {
    outlines.clear()
    for (const glyph of glyphs) glyph.destroy()
    glyphs.length = 0
    const slot = (center: Point) => {
      roundedRect(outlines, cardRect(layout, center), layout.cardWidth * 0.08).stroke({
        color: OUTLINE_COLOR,
        alpha: 0.35,
        width: 2,
      })
    }
    slot(layout.stock)
    slot(layout.waste)
    for (const suit of SUITS) {
      slot(layout.foundations[suit])
      const glyph = new Text({
        text: SUIT_GLYPHS[suit],
        style: { fontSize: layout.cardWidth * 0.5, fill: OUTLINE_COLOR },
      })
      glyph.alpha = 0.25
      glyph.anchor.set(0.5)
      glyph.position.set(layout.foundations[suit].x, layout.foundations[suit].y)
      glyph.zIndex = 0
      root.addChild(glyph)
      glyphs.push(glyph)
    }
    for (let index = 0; index < 7; index++) {
      slot({ x: layout.columnXs[index], y: layout.tableauTop })
    }
    // The stock zone is clickable even when empty: that click is recycle.
    stockZone.clear()
    roundedRect(stockZone, cardRect(layout, layout.stock), layout.cardWidth * 0.08).fill({
      color: 0xffffff,
      alpha: 0.001,
    })
    recycleGlyph = new Text({
      text: '⟳',
      style: { fontSize: layout.cardWidth * 0.6, fill: OUTLINE_COLOR },
    })
    recycleGlyph.alpha = 0
    recycleGlyph.anchor.set(0.5)
    recycleGlyph.position.set(layout.stock.x, layout.stock.y)
    recycleGlyph.zIndex = 0
    root.addChild(recycleGlyph)
    glyphs.push(recycleGlyph)
  }
  rebuildFurniture()

  // --- placing cards from a snapshot ---
  // z-bands, low to high: furniture 0-2, stock 10+, waste 100+,
  // foundations 200+, tableau 300 + column * 40 (a column holds at most 19
  // cards: 6 face-down plus a 13-card run, so the stride never overflows;
  // max 558), in-flight tweens LIFT_Z + final z (610-1158), dragged run
  // DRAG_Z+, hint overlay 2000. The bands assume resting zones never
  // overlap on screen — in the side-rail layout that is a horizontal
  // guarantee owned by layout.ts.
  function place(card: Card, target: Point, faceUp: boolean, zIndex: number, placeInfo: CardPlace, instant: boolean): void {
    const node = nodes.get(cardKey(card))!
    places.set(cardKey(card), placeInfo)
    // A card mid-drag keeps its lifted position and z-order; its metadata
    // above still updates so the drop can re-verify the run.
    if (drag !== null && drag.dragging && drag.keys.has(cardKey(card))) return
    node.faceSprite.visible = faceUp
    node.backSprite.visible = !faceUp
    node.faceSprite.width = layout.cardWidth
    node.faceSprite.height = layout.cardHeight
    node.backSprite.width = layout.cardWidth
    node.backSprite.height = layout.cardHeight
    node.container.eventMode = placeInfo.draggable ? 'static' : 'none'
    node.container.cursor = placeInfo.draggable ? 'pointer' : 'default'
    tweenTo(node.container, target, instant, zIndex)
  }

  function applySnapshot(snapshot: GameSnapshot, instant: boolean): void {
    const state = snapshot.state
    if (recycleGlyph !== null) {
      recycleGlyph.alpha = state.stock.length === 0 && state.waste.length > 0 ? 0.6 : 0
    }
    clearHint()
    state.stock.forEach((card, index) => {
      place(card, layout.stock, false, 10 + index, { zone: null, pileIndex: index, faceUpIndex: -1, draggable: false }, instant)
    })
    state.waste.forEach((card, index) => {
      const top = index === state.waste.length - 1
      place(
        card,
        wasteFanPos(layout, index, state.waste.length, state.config.drawCount),
        true,
        100 + index,
        { zone: { kind: 'waste' }, pileIndex: index, faceUpIndex: -1, draggable: top },
        instant,
      )
    })
    for (const suit of SUITS) {
      const pile = state.foundations[suit]
      pile.forEach((card, index) => {
        const top = index === pile.length - 1
        place(
          card,
          layout.foundations[suit],
          true,
          200 + index,
          { zone: { kind: 'foundation', suit }, pileIndex: index, faceUpIndex: -1, draggable: top },
          instant,
        )
      })
    }
    state.tableau.forEach((pile, column) => {
      const x = layout.columnXs[column]
      const counts = { faceDown: pile.faceDown.length, faceUp: pile.faceUp.length }
      pile.faceDown.forEach((card, index) => {
        place(
          card,
          { x, y: pileCardY(layout, counts, index) },
          false,
          300 + column * 40 + index,
          { zone: { kind: 'tableau', index: column }, pileIndex: index, faceUpIndex: -1, draggable: false },
          instant,
        )
      })
      pile.faceUp.forEach((card, faceUpIndex) => {
        const pileIndex = pile.faceDown.length + faceUpIndex
        place(
          card,
          { x, y: pileCardY(layout, counts, pileIndex) },
          true,
          300 + column * 40 + pileIndex,
          { zone: { kind: 'tableau', index: column }, pileIndex, faceUpIndex, draggable: true },
          instant,
        )
      })
    })
  }

  // --- pointer interaction ---
  interface DragState {
    readonly pointerId: number
    readonly startKey: string
    readonly spot: TapSpot | null
    readonly from: Zone
    readonly count: number
    readonly keys: ReadonlySet<string>
    readonly members: readonly CardNode[]
    readonly offsets: readonly Point[]
    readonly startGlobal: Point
    dragging: boolean
    // Set when a buttonless move arrives mid-drag; the ticker aborts the
    // drag once it has been stale past STALE_RELEASE_MS.
    staleSince: number | null
  }
  let drag: DragState | null = null
  let lastTap: { key: string; at: number } | null = null

  // Recovery for pointers that die without a pointerup (pixi registers no
  // pointercancel handler at all, and a release outside the window is
  // never delivered): snap the run home rather than leaving it glued to
  // the cursor.
  function abortDrag(): void {
    const active = drag
    drag = null
    if (active !== null && active.dragging && last !== null) applySnapshot(last, false)
  }

  function draggedRun(state: KlondikeState, key: string): { from: Zone; count: number; cards: readonly Card[]; spot: TapSpot | null } | null {
    const placeInfo = places.get(key)
    if (!placeInfo || !placeInfo.draggable || placeInfo.zone === null) return null
    if (placeInfo.zone.kind === 'waste') {
      const top = state.waste[state.waste.length - 1]
      return { from: placeInfo.zone, count: 1, cards: [top], spot: { kind: 'waste' } }
    }
    if (placeInfo.zone.kind === 'foundation') {
      const pile = state.foundations[placeInfo.zone.suit]
      return { from: placeInfo.zone, count: 1, cards: [pile[pile.length - 1]], spot: null }
    }
    const pile = state.tableau[placeInfo.zone.index]
    const cards = pile.faceUp.slice(placeInfo.faceUpIndex)
    return {
      from: placeInfo.zone,
      count: cards.length,
      cards,
      spot: { kind: 'tableau', index: placeInfo.zone.index, cardIndex: placeInfo.faceUpIndex },
    }
  }

  function onCardDown(key: string, event: FederatedPointerEvent): void {
    // A second pointer never steals an armed drag; a resting thumb must
    // not hijack the gesture.
    if (drag !== null || last === null) return
    const run = draggedRun(last.state, key)
    if (run === null) return
    const members = run.cards.map((card) => nodes.get(cardKey(card))!)
    // Kill in-flight tweens now so the grab offsets are measured against
    // where the cards actually are, not where a tween was taking them.
    for (const member of members) tweens.delete(member.container)
    const global = { x: event.global.x, y: event.global.y }
    drag = {
      pointerId: event.pointerId,
      startKey: key,
      spot: run.spot,
      from: run.from,
      count: run.count,
      keys: new Set(run.cards.map(cardKey)),
      members,
      offsets: members.map((member) => ({ x: member.container.x - global.x, y: member.container.y - global.y })),
      startGlobal: global,
      dragging: false,
      staleSince: null,
    }
  }

  function onPointerMove(event: FederatedPointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return
    // Buttonless moves: either the tail of a live release (pointerup lands
    // next frame and resolves the drop) or a hover after a pointerup that
    // was never delivered. Freeze the run and let the ticker decide: a
    // prompt pointerup wins, a sustained stale hover aborts.
    if (drag.dragging && event.buttons === 0) {
      if (drag.staleSince === null) drag.staleSince = performance.now()
      return
    }
    drag.staleSince = null
    const global = { x: event.global.x, y: event.global.y }
    if (!drag.dragging) {
      const moved = Math.hypot(global.x - drag.startGlobal.x, global.y - drag.startGlobal.y)
      if (moved < DRAG_THRESHOLD_PX) return
      drag.dragging = true
      lastTap = null
      drag.members.forEach((member, index) => {
        member.container.zIndex = DRAG_Z + index
      })
    }
    drag.members.forEach((member, index) => {
      member.container.position.set(global.x + drag!.offsets[index].x, global.y + drag!.offsets[index].y)
    })
  }

  function onPointerUp(event: FederatedPointerEvent): void {
    if (drag !== null && event.pointerId !== drag.pointerId) return
    const active = drag
    drag = null
    if (active === null || last === null) return
    if (!active.dragging) {
      // A press without movement is a tap; two quick taps auto-move.
      const at = Date.now()
      const isDouble = lastTap !== null && lastTap.key === active.startKey && at - lastTap.at < DOUBLE_TAP_MS
      lastTap = isDouble ? null : { key: active.startKey, at }
      if (isDouble && active.spot !== null) handlers.onTap(active.spot)
      return
    }
    // The board may have changed under the drag (undo, auto-finish): the
    // captured from/count are positional, so re-verify the grabbed cards
    // still are that run before replaying them.
    const runNow = draggedRun(last.state, active.startKey)
    const sameRun =
      runNow !== null &&
      runNow.count === active.count &&
      JSON.stringify(runNow.from) === JSON.stringify(active.from) &&
      runNow.cards.every((card) => active.keys.has(cardKey(card)))
    // Resolve the drop where the player sees the card, not the pointer:
    // the grab offset can be half a card wide.
    const primary = { x: event.global.x + active.offsets[0].x, y: event.global.y + active.offsets[0].y }
    const target = sameRun ? dropTargetAt(layout, primary) : null
    let applied = false
    if (target !== null) {
      const to: Zone = target.kind === 'foundation' ? { kind: 'foundation', suit: target.suit } : { kind: 'tableau', index: target.index }
      applied = handlers.onAction({ type: 'move', from: active.from, to, count: active.count })
    }
    // On success the store notifies and update() retargets everything; a
    // refused or missed drop snaps the run home from the last snapshot.
    if (!applied) applySnapshot(last, false)
  }

  for (const [key, node] of nodes) {
    node.container.on('pointerdown', (event: FederatedPointerEvent) => onCardDown(key, event))
  }
  app.stage.on('pointermove', onPointerMove)
  app.stage.on('pointerup', onPointerUp)
  app.stage.on('pointerupoutside', onPointerUp)
  app.stage.on('pointercancel', abortDrag)
  window.addEventListener('blur', abortDrag)
  stockZone.on('pointertap', () => {
    if (last === null) return
    const state = last.state
    if (state.stock.length > 0) handlers.onAction({ type: 'draw' })
    else if (state.waste.length > 0) handlers.onAction({ type: 'recycle' })
  })

  function onResize(): void {
    // A resize invalidates a live drag's grab offsets and card size; snap
    // the run home rather than dropping at stale geometry.
    abortDrag()
    layout = computeLayout(app.screen.width, app.screen.height)
    rebuildFurniture()
    if (last !== null) applySnapshot(last, true)
  }
  app.renderer.on('resize', onResize)

  return {
    update(snapshot) {
      last = snapshot
      lastTap = null
      applySnapshot(snapshot, false)
    },

    // Contract: the action must be legal in the snapshot most recently
    // passed to update(); the guards below only keep a stale action from
    // throwing.
    flashHint(action) {
      if (last === null) return
      clearHint()
      const state = last.state
      const highlight = (center: Point) => {
        const rect = cardRect(layout, center, -4)
        hintOverlay.roundRect(rect.x, rect.y, rect.width, rect.height, layout.cardWidth * 0.1).stroke({
          color: HINT_TINT,
          width: 4,
        })
      }
      if (action.type === 'draw' || action.type === 'recycle') {
        highlight(layout.stock)
      } else {
        if (action.from.kind === 'tableau') {
          const pile = state.tableau[action.from.index]
          for (let i = Math.max(0, pile.faceUp.length - action.count); i < pile.faceUp.length; i++) {
            nodes.get(cardKey(pile.faceUp[i]))!.faceSprite.tint = HINT_TINT
          }
        } else if (action.from.kind === 'waste' && state.waste.length > 0) {
          nodes.get(cardKey(state.waste[state.waste.length - 1]))!.faceSprite.tint = HINT_TINT
        } else if (action.from.kind === 'foundation') {
          highlight(layout.foundations[action.from.suit])
        }
        const target =
          action.to.kind === 'foundation'
            ? layout.foundations[action.to.suit]
            : action.to.kind === 'tableau'
              ? { x: layout.columnXs[action.to.index], y: layout.tableauTop }
              : layout.waste
        highlight(target)
      }
      hintElapsed = 0
    },

    destroy() {
      app.ticker.remove(tick)
      app.renderer.off('resize', onResize)
      app.stage.off('pointermove', onPointerMove)
      app.stage.off('pointerup', onPointerUp)
      app.stage.off('pointerupoutside', onPointerUp)
      app.stage.off('pointercancel', abortDrag)
      window.removeEventListener('blur', abortDrag)
      root.destroy({ children: true })
      back.destroy(true)
    },
  }
}
