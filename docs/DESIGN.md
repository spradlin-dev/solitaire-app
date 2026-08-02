# Solitaire App — Design

Status: DRAFT v2 — revised after adversarial review (qwen, fable, opus, sonnet — 2026-08-02).
Not yet approved.

## 1. What we're building

A web-based Klondike solitaire game that installs as a PWA and works fully offline.
It is a static site — no server, no accounts, no network calls after install — deployed
to GitHub Pages from this repo (`spradlin-dev/solitaire-app`).

## 2. Decisions already made

| Decision | Choice |
| --- | --- |
| Variant | Klondike (engine shaped so other variants can be added later) |
| Hosting | GitHub Pages, deployed by GitHub Actions |
| Draw mode | Setting: Draw 1 or Draw 3. New games default to Draw 3 |
| Redeals | Unlimited passes through the stock |
| Scoring | No point score in v1 — stats only (wins, streak, best time, fewest moves) |
| Assists | Unlimited undo, auto-finish, tap-to-auto-move, hint button with loss detection |
| Rendering | pixi.js canvas (chosen knowing drag/animation are net-new — see 5.3) |
| Loss stats | One record per deal, written at its end: win, or loss when a new deal starts first |
| Seed sharing | In v1 — shareable deal links (`#deal=<seed>.<drawCount>`) |
| Auto-finish trigger | Mode-aware: strict in Draw 3; Draw 1 also offers it once all tableau cards are face-up |

## 3. Game rules (precise spec)

Standard 52-card deck, seeded shuffle (reused `prng.ts` + `deck.ts`).

**Pile conventions.** Every pile (stock, waste, foundations, tableau) is an array whose
**last element is the top card**. These conventions are load-bearing for the draw-3
ordering and the loss-detection proof, and are pinned by fixture tests (section 8).

**Deal.** Seven tableau piles: pile *i* gets *i* cards (1–7), only the top card face up
(28 cards total). The remaining 24 cards form the face-down stock. Waste and the four
foundations start empty.

**Goal.** All 52 cards on the foundations, each foundation building one suit A → K.
The engine exposes this as `isWon(state)`.

**Legal moves.**
- **Draw** (legal only when the stock is non-empty): repeat `drawCount` times (or until
  the stock empties): pop the stock's top card, push it face-up onto the waste. So in
  Draw 3, the third card popped ends up on top and is the playable one. Only the top
  waste card is ever playable.
- **Recycle** (legal only when the stock is empty AND the waste is non-empty): the new
  stock is the reversed waste array; the waste becomes empty. (Physically: flip the
  waste pile over. The first card ever drawn becomes the next card drawn, so repeated
  move-free passes expose exactly the same sequence.) Unlimited. A distinct action —
  never an automatic side effect of drawing.
- **Waste top → tableau or foundation**, if it fits the target's rule.
- **Tableau → tableau:** a **run** — one or more *face-up* cards in consecutive
  descending rank, alternating colors — moves onto a top card exactly one rank higher
  of the opposite color. Face-down cards never move as part of a run. An empty column
  accepts only a King or a run starting with a King.
- **Tableau top → foundation:** next rank of that suit (Ace onto an empty foundation).
- **Foundation top → tableau:** allowed (standard rule); the card must fit the tableau
  target exactly as any other card would (one rank higher, opposite color; a King may
  go to an empty column).
- When a face-down tableau card becomes exposed, it flips face up automatically.

**Rank ordering.** Klondike needs a total order A=1 … K=13. The engine provides
`rankIndex(rank)` (position in `RANKS`). Gin's `cardValue` (J/Q/K/10 all = 10 — gin
scoring) is **not copied** into this project; see section 9.

**Draw-mode switching.** The Draw 1/3 setting applies to the *next new deal*. A game in
progress — including a saved one — always replays with the config stored in its save
at deal time, never the current settings.

## 4. Loss detection

The hint button must be able to say "this game is lost." Two provable-loss conditions,
both computed **on demand in `helpers.ts` as a pure function of the current position** —
there is no tracking flag inside engine state:

1. **No legal actions at all.** If `legalActions(state)` is empty and the game is not
   won (possible once stock and waste are both empty and the tableau is stuck), the
   game is lost immediately.
2. **Sterile cycle (simulation).** From the current position, simulate applying only
   draw and recycle until the stock/waste configuration returns to the starting one.
   Pure draws never reorder the deck, so this cycle is finite, deterministic, and cheap
   (O(deck size); tableau/foundation moves can't change during it, so per-step work is
   just "can the current waste top go anywhere"). If at no point in the whole cycle any
   non-draw/recycle action is legal, the position repeats forever → provably lost.

Condition 2 subsumes the original "sterile pass" rule and improves on it: the hint can
declare the loss the moment it becomes true, instead of only after the player manually
grinds through a full pointless pass.

Honesty constraints:
- **No false positives.** Any legal non-draw action that changes the board's
  facts — including pulling a foundation card back down — blocks the
  declaration. A pointless move (section 5.3: a bare King-led pile hopping
  between empty columns; a partial run hopping between matching parents
  while the exposed card cannot go to its foundation; a whole pile moved to
  free a column when the open columns already meet every King's possible
  need; or a foundation card pulled down when its tenant chain grounds in
  no useful move — an Ace or
  Two never has a useful tenant, and a taller pull needs a card one rank
  lower and the opposite color to land on it, where the waste top grounds
  the chain, a face-up tableau card grounds it only if relocating it would
  itself be useful (it heads its run, or the parent it exposes can go up),
  and another foundation's top counts only if its own pull is useful in
  turn) provably preserves the position and does not block, so a player
  whose only moves are pointless is told the game is over instead of being
  sent around the stock forever. We only declare death when it is provable.
- **False negatives are accepted.** Games can be unwinnable long before these checks
  can prove it; that requires a solver, out of scope for v1. Hint wording separates
  "game over — no winning line exists from here" (proven) from ordinary hints.

## 5. Architecture

Three layers, strictly separated:

### 5.1 Engine (`src/engine/`) — pure TypeScript, no DOM, no framework

Copied from gin-rummy (`clients/web/src/engine/`): `cards.ts`, `deck.ts`, `prng.ts`,
`testCards.ts` and their tests — minus gin's scoring helper (section 9).

New: `klondike.ts`. The API follows gin's *pattern* but deliberately diverges where
Klondike's assists need more (gin returns action-type names only; we need concrete
moves):

- `initialState(seed, config) → KlondikeState` — deterministic deal from a PRNG seed.
- `advance(state, action) → AdvanceResult` where
  `AdvanceResult = { ok: true; state } | { ok: false; reason: RejectReason }` —
  pure; same shape as gin's (`game.ts:48`).
- `legalActions(state) → Action[]` — **complete and sound over concrete actions**: it
  emits every legal move as a full action object, and everything it emits is accepted
  by `advance`. Loss detection and hints rest on this contract, so it is
  property-tested against an independent oracle (section 8). Equivalent actions are
  canonicalized: multiple empty columns yield one action (leftmost); `advance` itself
  accepts any empty column as a target.
- `isWon(state) → boolean`.

`KlondikeState` is a plain serializable object — a pure *position*, no history: stock,
waste, foundations (suit-keyed record), seven tableau piles (face-down portion +
face-up run), config, move count. Actions: `draw`, `recycle`,
`move { from, to, count }` — `from`/`to` name a zone (waste, a tableau column index, or
a foundation suit).

New: `helpers.ts` — assist logic built *on top of* the engine, never inside it: hint
selection, loss detection (section 4), auto-finish, tap-to-auto-move. Helpers only
read state and emit primitive engine actions.

### 5.2 State/store (`src/store.ts`, `src/persistence.ts`, `src/stats.ts`)

- **Single source of truth: the action log.** The current game is
  `{ seed, config, actionLog }`; states are derived by replay through `advance`.
  The store keeps an in-memory stack of derived states for O(1) undo, but the stack is
  a cache — it is rebuilt from log prefixes after a reload, so undo depth survives
  reloads too.
- **Undo** pops the last entry off the action log (and the cached state). Unlimited.
  Undo can cross back to move zero, but never clears the sticky `played` flag (below).
- **Persistence:** localStorage, written after every action and on `visibilitychange`.
  The saved blob is `{ schemaVersion, engineVersion, seed, config, actionLog,
  elapsedMs, played, recorded }`. `recorded` persists the one-record-per-deal
  latch: without it, a win that is undone, saved, reloaded, and re-won would
  write a second stats record. `elapsedMs` accumulates active play time so
  "best time" survives reloads. On load: version mismatch or any replay rejection ⇒ discard the
  in-progress game gracefully (keep settings and stats) and start fresh — never crash,
  never guess.
- **Stats:** wins, losses, current/best streak, best time, fewest moves — bucketed by
  draw mode, stored separately from game saves. A deal is `played` once its first move
  is made; the flag is set then and never cleared (not derived from move count, so
  undoing everything can't erase it). **Each played deal produces exactly one record,
  written when the deal ends:** a win when `isWon` becomes true, a loss when a new deal
  is started first. A proven loss shows the message but does not lock the game or write
  a record — the player may undo out of the dead end and still win.
  Restarting the same deal (a toolbar action) replays its seed from move zero with a
  fresh clock and move count: no record is written and the sticky `played` flag
  survives (the deal was still played); the undo history goes with the log, so a
  restart cannot itself be undone.

### 5.3 UI (`src/ui/`) — React shell + pixi.js table

- React renders the chrome: the toolbar (new game, restart deal, undo, hint,
  auto-finish, share), settings, stats panel, win/lose overlays.
- The table is a pixi.js canvas. **Honest reuse scope** (verified against gin's code):
  what carries over is `TableCanvas.tsx`'s pixi mount/lifecycle pattern and
  `cardAssets.ts` + the 52 card SVGs. Gin's `scene.ts` is tap-only, gin-specific
  layout, and rebuilds all sprites every update — so the following is **net-new
  work**: Klondike layout (7 overlapping cascades, 4 foundations, stock/waste), a
  persistent sprite graph, drag-and-drop of multi-card runs with drop-target hit
  testing, and tween-based animation (required for auto-finish). A card-back design is
  also a new asset (the Knoll SVG set has none; gin generated one with `Graphics`).
- Table background: solid `#3A5D6F` (RGB 58, 93, 111) — matched to the camera
  background color in the sibling Unity project `solitaire-sample-project`.
- Interactions: drag-and-drop plus tap. Double-click/tap = auto-move (foundation
  first, else leftmost legal tableau spot; tapping mid-run moves the run from that
  card down).
- Hint button: highlights the suggested move. Priority: move that flips a face-down
  card > foundation move > tableau move that frees a column or card > waste play >
  "draw". If loss detection (section 4) fires, show the game-lost message — withheld
  until the player has cycled the stock at least once since their last real move
  (when cards remain to cycle): the proof may exist earlier, but the player gets to
  finish looking first. A move that leaves the board functionally unchanged is never
  hinted, not even as a last resort: a lone King-led pile hopping to another empty
  column, a partial run hopping between matching parent cards (the two parents
  necessarily share rank and color) when the card it would expose cannot go to its
  foundation, a whole pile moved to free a column when the open columns already
  meet every King's possible need (only Kings use empty columns, and each needs
  at most one), or a foundation card pulled down when its tenant chain grounds in
  no real card (an Ace or Two never qualifies; see section 4). When no fact-changing
  action exists at all and the loss is not provable, the hint reports "no useful
  move" instead (distinct from the game-lost message).
- Share deal: a Share button copies a link like
  `https://spradlin-dev.github.io/solitaire-app/#deal=<seed>.<drawCount>`. On load, a
  `#deal=` fragment starts exactly that deal in that draw mode. The fragment never
  reaches the server or the service worker's cache matching, so the PWA and Pages
  setup are unaffected. Shared deals record stats like any other deal.
- Auto-finish button. The trigger is mode-aware, and the button only ever appears
  when the win is provable:
  - **Draw 3:** no face-down cards remain AND at most one card is left across the
    stock and waste — a single remaining card is always reachable as the waste
    top, while two can hide one under the other forever.
  - **Draw 1:** no face-down cards remain (stock/waste may still hold cards).
  Safety argument: face-up tableau sections are always valid descending alternating
  runs (an invariant property-tested in section 8), so each pile's smallest card is
  its top. The lowest card not yet on a foundation therefore either sits on a tableau
  top (nothing can legally cover it — every lower card is already up), or sits in the
  stock/waste — and in Draw 1, unlimited redeals surface every stock card once per
  pass, so it can always be reached and played. Induction completes the game. Draw 3
  needs the empty-stock clause because buried stock cards there may never surface.
  Auto-finish emits the needed moves — including draws/recycles in the Draw 1 case —
  animated.

## 6. PWA design

- `vite-plugin-pwa`. Everything is static and bundled; the service worker precaches
  the entire app; zero network needed after first visit.
- GitHub Pages serves project sites under a subpath, so the subpath is pinned
  everywhere it matters: Vite `base: '/solitaire-app/'`, and in the manifest
  `id`, `start_url`, and `scope` all set to `/solitaire-app/` (otherwise an installed
  app can launch at the domain root and 404). `navigateFallback` points at
  `/solitaire-app/index.html`. No client-side router (single screen).
- Manifest: standalone display, 192/512 + maskable icons (new asset task), plus an
  `apple-touch-icon` link and iOS meta tags — iOS ignores manifest icons for
  Add-to-Home-Screen.
- Updates: `registerType: 'prompt'` — an "update available" toast, no silent mid-game
  reload. Because a solitaire tab can stay open for days and the browser only checks
  for a new SW on navigation, the app calls `registration.update()` periodically
  (e.g. hourly) and on `visibilitychange`, per vite-plugin-pwa's periodic-update
  recipe. In-progress games survive updates via persistence (5.2).
- Storage durability: request `navigator.storage.persist()` on first game. Stats
  export/import is backlog (section 10).
- Manual release check (first deploy and after PWA config changes): install from the
  Pages URL, kill the network, relaunch from the home screen.

## 7. Deployment (CI/CD)

One workflow, `.github/workflows/deploy.yml`. `package-lock.json` is committed.

- **On pull requests:** `npm ci` → `oxlint` → `npm run build` (which is
  `tsc -b && vite build`, so PRs are type-checked — vitest and vite alone strip types
  without checking them) → `vitest run` → smoke-check `dist/`: `index.html`,
  `manifest.webmanifest`, and the generated service worker exist and are referenced.
- **On push to `main`:** same steps, then publish `dist/` with
  `actions/upload-pages-artifact` + `actions/deploy-pages`.
- Deploy job details reviewers flagged as required, not optional:
  `permissions: { contents: read, pages: write, id-token: write }` (a `permissions:`
  block zeroes anything unlisted — omitting `contents: read` breaks checkout),
  `environment: github-pages`, and `concurrency: { group: pages,
  cancel-in-progress: false }` on the deploy job so deployments never overlap.
  Overlap-prevention alone can still publish an older commit after a newer one
  (slow run A builds while run B lands and deploys first; A then deploys on top);
  a workflow-level `concurrency` group per ref with `cancel-in-progress: true`
  cancels the superseded run before it reaches the deploy queue.
- Auth is GitHub's built-in OIDC — no secrets to create or rotate.
- One-time manual step: repo Settings → Pages → Source: "GitHub Actions".

Node 22, npm. Single flat package at the repo root (no monorepo — there is no server).

## 8. Testing

vitest + fast-check (same stack as gin-rummy). Reused engine tests come along, minus
gin's `cardValue` assertions (section 9).

Klondike unit tests:
- Deal shape (pile sizes 1–7, face-up counts, stock 24).
- Each move rule accepts/rejects correctly — including foundation→tableau and
  King-to-empty-column, each with a test showing its availability *blocks* a loss
  declaration (guards against `legalActions` omissions silently poisoning loss
  detection).
- **Pinned conventions fixtures:** exact waste top after each of the first draws in
  Draw 3 mode, and exact stock order after a recycle (section 3's array conventions,
  which section 4's proof depends on).
- Sterile-cycle and no-legal-actions loss detection on constructed dead positions
  (via `testCards.ts` fixtures); win detection.
- Replay uses the config saved with the game, not current settings.
- `#deal=` link parsing: seed + draw mode round-trip; malformed fragments fall back to
  a normal new deal.

Property tests (fast-check, random seeds + random legal-action sequences):
- Card conservation: every reachable state contains exactly the 52 unique cards.
- **Oracle equivalence:** a brute-force test-only enumerator (try every source/target/
  count through `advance`) returns exactly the same set as `legalActions` — the
  completeness contract that loss detection rests on, tested against an independent
  implementation rather than itself.
- **Tableau-run invariant:** every reachable face-up section is a valid descending
  alternating run (the auto-finish safety argument).
- Determinism: same seed + same action list ⇒ identical state.
- Undo integrity: replaying the log minus the last action equals the popped state.
- Persistence round-trip: save → load → identical state; corrupted/mismatched saves
  are discarded without touching stats.

Helper tests (`helpers.ts` — previously a blind spot):
- Auto-finish: from any generated state satisfying its trigger — including Draw 1
  states with a non-empty stock/waste — replaying its emitted actions reaches
  `isWon`.
- Hint never returns an action `advance` rejects; unit tests pin the priority
  ordering and tie-breaks.
- Tap-to-auto-move target selection, including the tapping-mid-run case.

## 9. Reuse from gin-rummy (copy, don't share)

Copied: `src/engine/{cards,deck,prng,testCards}.ts` + tests, `src/assets/cards/`
(52 SVGs + PROVENANCE.md), `TableCanvas.tsx`'s mount pattern, `cardAssets.ts`, and the
toolchain configuration approach (Vite, React, TS, pixi.js, vitest, oxlint).

**Pruned during the copy:** `cardValue` and its tests. It encodes gin scoring
(J/Q/K/10 all = 10) and is a trap for Klondike sequencing — `rankIndex` (section 3)
is the ordering helper here. Not copied: `melds.ts`, `game.ts`, `scene.ts` layout
(gin-specific).

We copy rather than extract a shared package; extraction is warranted only if a third
card game appears or an engine change must land in both repos.

## 10. Non-goals (v1)

- Other solitaire variants (the config-driven engine leaves the door open).
- Point/Vegas scoring (stats only).
- Solver, winnable-only deals, or perfect loss detection beyond section 4.
- Multiplayer, accounts, server anything.
- Sound, elaborate animations beyond auto-finish/card movement, daily challenges,
  localization, stats export/import (backlog: cheap and worth doing soon after v1).

## 11. Remaining open questions

None. The last two (auto-finish trigger, seed sharing) were decided on 2026-08-02 and
folded into sections 2, 5.3, and 8.

## Review log

- 2026-08-02: DRAFT v1 reviewed adversarially by qwen (local), fable, opus, and sonnet
  (independent fresh-context agents). 19 distinct confirmed findings folded into v2;
  headline fixes: loss detection redesigned as on-demand simulation (v1's flag could
  never fire with an empty waste and only confirmed retroactively), engine API
  contract corrected against gin's real `AdvanceResult`, action log made the single
  source of truth for undo+persistence with version-stamped saves, CI gained
  type-checking and required Pages workflow settings, PWA gained subpath-correct
  manifest identity and update polling, and the pixi reuse claim was cut down to what
  gin's code actually provides.
- 2026-08-02 (v2.1): seed sharing pulled into v1 scope; auto-finish trigger made
  mode-aware (Draw 1 offers it once all tableau cards are face-up).
