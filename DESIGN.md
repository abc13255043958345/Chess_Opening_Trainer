# Chess Opening Trainer — Design Doc

A personal iPhone app for learning chess openings through repetition. You pick a repertoire,
the app drills you on it as White or Black (including punishing opponents' inaccurate moves),
flags every deviation from theory with an explanation, and tracks how well you know each
opening and each branch within it.

---

## 1. Platform decision

**Build this as a Progressive Web App (PWA), not a native iOS app.**

Rationale:
- Development happens on Windows; native iOS requires Xcode on a Mac plus an Apple
  Developer account for distribution.
- A PWA installs to the iPhone home screen ("Add to Home Screen" in Safari), runs
  full-screen with no browser chrome, and works fully offline via a service worker.
- Stockfish compiles to WebAssembly and runs client-side, so the eval bar and theory
  calculator need no server at all.
- The whole app is static files — hostable free on GitHub Pages / Netlify / Vercel,
  or run locally during development.

Alternative if native is ever required: React Native + Expo (EAS cloud builds work from
Windows), reusing the same TypeScript core logic. The data model below is UI-agnostic to
keep that door open.

**Tech stack:**
- TypeScript + React + Vite (PWA plugin for offline/service worker)
- `chess.js` — move legality, FEN/PGN handling
- `chessground` (Lichess's open-source board) or `react-chessboard` — touch-friendly board UI
- `stockfish.wasm` (or `stockfish.js` single-threaded fallback) — runs in a Web Worker
- `IndexedDB` (via `idb` or Dexie) — repertoire data, training history, stats. No backend.
- All data local to the device; export/import via JSON file for backup.

---

## 2. Core concepts and data model

Everything hangs off one structure: the **repertoire tree**.

### Repertoire
A named collection of lines the user has chosen to learn, split by color.
Example: "White: Italian Game", "Black: Caro-Kann", "Black vs 1.d4: KID".

### Move tree
Each repertoire is a tree of positions. A node represents a position reached by a
sequence of moves:

```ts
interface RepertoireNode {
  id: string;                 // stable id (hash of move path)
  fen: string;                // position after this move
  san: string;                // move that led here, e.g. "Nf3"
  uci: string;                // e.g. "g1f3"
  parentId: string | null;
  children: string[];         // ids of continuations

  // Whose move produced this node relative to the trainee
  mover: "user" | "opponent";

  // Classification of this move within the tree
  moveKind: "mainline" | "sideline" | "opponent_mistake";

  // For opponent_mistake nodes: the children are the punish line
  annotation?: {
    explanation: string;      // why this move / why the alternative fails
    plans?: string;           // typical middlegame ideas from here
  };

  // Line termination
  endOfTheory?: {
    reason: "winning" | "clear_plan";   // "clearly winning" or "theory done, play chess"
    evalCp?: number;                    // cached engine eval in centipawns at line end
  };

  // Popularity weight for opponent move selection (see §4.2)
  weight?: number;
}
```

Key rules:
- **One tree per repertoire per color.** User-to-move nodes have exactly one *correct*
  continuation in theory (the repertoire choice); opponent nodes may have many children
  (all the replies the user should be prepared for, including mistakes).
- **Lines end when clearly winning or when theory ends** — marked explicitly with
  `endOfTheory`, with a cached engine eval so the UI can show "you finish here at +1.8".
- **Opponent mistakes are first-class branches** (`moveKind: "opponent_mistake"`) with
  their own punish lines and explanations. This is how the app teaches refutations, not
  just main lines.

### Opening database — ship ALL standard openings with theory pre-loaded

The app comes with full standard opening theory built in; the user browses the catalog,
toggles openings into their active training set, and drills immediately. Authoring/editing
(§4.5) still exists but is for extending or customizing, not a prerequisite.

No free dataset contains complete *annotated* theory, so the content is produced by a
**build-time content pipeline** (a Node script in this repo, run on the dev machine, its
output bundled with the app as static JSON):

1. **Skeleton:** the Lichess `chess-openings` dataset (CC0, ~3,500 named openings with
   ECO codes and move sequences) provides the catalog: names, ECO, entry move orders.
2. **Deepening:** for each opening, walk the **Lichess Explorer API** (masters database +
   high-rated Lichess pool) to extend the tree with real continuations. Expansion rules:
   - include an opponent reply if it appears in ≥ ~2% of games from that position
     (captures both theory and *common* deviations);
   - for user-to-move nodes, the mainline choice is the masters' most popular move
     (single correct answer per position, per §2 rules);
   - stop a branch when position count drops below a floor (theory has run out) or the
     cached engine eval passes ±1.5 (clearly winning/lost) or a max ply (~24) is hit;
     stamp `endOfTheory` accordingly.
3. **Mistake branches:** opponent moves that are popular in the Lichess pool but rare in
   masters games, or that lose ≥ ~0.7 eval, are tagged `opponent_mistake`, with the punish
   line taken from the engine's PV.
4. **Evals:** Stockfish (desktop, deeper search than in-app) stamps `evalCp` on every node
   during the build — the in-app eval bar reads these from cache along theory lines.
5. **Explanations:** generated at build time per user-move and mistake node — mechanically
   from engine data at minimum ("2...d5? drops a pawn to 3.exd5, eval +1.1"), and
   optionally enriched by a Claude API pass over each node (position, move, eval delta,
   PV → 1–2 sentence explanation) for human-quality "why". Generated once, shipped as
   static content; the app itself stays offline and key-free.

**Packaging:** one JSON file per ECO section (A–E) or per opening family, lazy-loaded and
cached in IndexedDB on first use. Expected total on the order of tens of MB uncompressed —
fine for a PWA; served compressed, loaded incrementally.

The pipeline is re-runnable (deeper depth, better explanations, updated popularity) and
its parameters (popularity threshold, eval cutoffs, max ply) live in one config block.

---

## 3. Screens

1. **Home / Dashboard** — overall mastery, streak, "due today" count, per-repertoire cards
   with progress rings. Tap a card → repertoire detail.
2. **Repertoire detail** — tree/branch view of the opening with per-branch mastery
   heat coloring (see §5). Buttons: Practice, Explore, Edit.
3. **Practice (the core screen)** — board + eval bar + feedback panel. See §4.
4. **Explorer / Theory calculator** — free board, engine always on. See §4.4.
5. **Repertoire editor** — build/edit trees: make moves on the board, mark
   mainline/sideline/mistake, write explanations, set end-of-theory. PGN import/export.
6. **Stats** — history charts, weakest branches list, accuracy over time.

Mobile-first layout: board fills the width, eval bar as a thin vertical strip on the
board's left edge, feedback/controls below the board. Everything reachable with a thumb.

---

## 4. Features

### 4.1 Practice mode (drill loop)

Session setup: pick repertoire(s) → pick color (fixed by repertoire) → pick scope
(whole repertoire / one branch / "due cards only") → pick depth (full lines vs. stop at
first unlearned node).

The loop:
1. Board is set to the start (or a mid-line checkpoint for targeted drills). If user is
   Black, the app plays White's first move.
2. **Opponent moves** are sampled from the current node's children (see 4.2) — sometimes
   theory, sometimes a curated mistake.
3. **User moves.** The app checks it against the tree:
   - **Correct (theory move, or correct punish of a mistake):** subtle confirmation
     (green flash), line continues.
   - **Deviation (mistake handling — this exact sequence):**
     1. The move is rejected visually (shown in red, piece snaps back).
     2. The feedback panel names the mistake ("you played 4.d3") and shows:
        - the correct move,
        - `annotation.explanation` for the correct node — *why* this move is right and
          why the played move is worse,
        - the next 3–5 theory moves as a preview line ("and play continues Nf3 Nc6 Bb5…"),
        - optionally the engine eval delta of the attempted move vs. the theory move
          (computed on-device, cached).
     3. The user **must play the correct move themselves** to continue — no "next" button
        that skips the physical repetition. The node is marked failed for SRS (§5), and
        the line is flagged dirty for this run.
4. Line ends at an `endOfTheory` node → "Line complete" card: final eval, the plan text,
   accuracy for this run.
5. **Replay-until-clean:** if the user made *any* mistake during the line, the board
   resets and the **same line replays from the start** — identical opponent moves (the
   sampled opponent sequence is pinned for the retry, not re-sampled), so the user is
   re-tested on exactly the situation they failed. This repeats until the user completes
   the line with **zero mistakes and no hints**. Only a clean pass advances the session
   to the next line/situation.
   - Retries count as additional attempts for SRS stats, but only the *first* attempt at
     each node determines its pass/fail scheduling (so grinding a line clean doesn't
     inflate its mastery).
   - Escape hatch: a "skip line" action (buried, not prominent) marks the line failed
     and moves on, for when the user genuinely wants out.

Explanations: primarily authored/imported text on nodes. Where a node has no annotation,
fall back to an auto-generated one from engine analysis ("2...d5 loses a pawn to 3.exd5"
built from the punish line + eval). Authoring good explanations is content work, not app
work — the editor should make it fast.

### 4.2 Opponent move selection

At each opponent node, sample among children:
- Default mix: **~80% theory moves** (weighted by `weight`/popularity among theory
  children), **~20% curated mistakes** (`opponent_mistake` children), configurable per
  session ("theory only" / "mix" / "mistakes only" for refutation drills).
- The opponent **never plays a move that isn't in the tree** — every position the user
  faces has a defined correct answer. (Free play against arbitrary engine moves belongs
  in the Explorer, not the drill.)
- Selection is biased toward branches with **low mastery scores** so weak lines come up
  more often (interleaving, not just SRS due-dates).

### 4.3 Eval bar

- Vertical white/black advantage bar beside the board, present in Practice and Explorer.
- Powered by Stockfish WASM in a Web Worker, capped at low depth (~depth 12–16 or
  ~200ms/move) — plenty for opening evals, keeps the phone cool.
- In Practice, evals along theory lines are **precomputed at repertoire-edit time and
  cached on nodes**, so the bar updates instantly and the engine only runs live when the
  user deviates (to show the eval cost of their move).

### 4.4 Explorer / theory calculator

- Free board: set up any position (or jump there from any point in practice/repertoire
  view via "open in Explorer").
- Engine always on: eval bar + top 3 engine lines with evals, updating as you move.
- Overlay showing which moves are **in your repertoire** (highlighted) vs. off-book, so
  "what if I played X instead?" is answered with both the engine's view and your book's.
- "Add to repertoire" button: any explored line can be grafted into the tree from here.

### 4.5 Repertoire editor

- Board-driven: play moves to extend the tree; long-press a move in the move list to mark
  it mainline / sideline / opponent-mistake, edit its explanation, set end-of-theory.
- PGN import (Lichess study exports preserve comments and variations → map to
  annotations and branches). PGN export for backup.
- "Coverage check" utility: lists opponent nodes where popular replies (per Explorer API
  data) have no prepared answer in the tree.

---

## 5. Mastery tracking and spaced repetition

### Per-node SRS
Every **user-move node** is a flashcard. Use a simple SM-2 variant:
- Each node stores: `easeFactor`, `intervalDays`, `dueDate`, `lapses`, `attempts`,
  `correctStreak`, `lastSeen`.
- Correct on first try → interval grows; hesitation (configurable: >10s) → smaller
  growth; wrong → lapse, interval resets short.
- "Due today" on the dashboard = count of due nodes.

### Branch and opening mastery
- **Node score** ∈ [0,1]: function of correct streak, recency, and lapses
  (e.g. `score = retrievability × accuracy`, concrete formula left to implementation but
  must be monotonic in streak and decay with time since last review).
- **Branch mastery** = depth-weighted average of user-move node scores in that subtree
  (deeper nodes weighted slightly less — knowing move 5 matters more than move 14).
- **Opening mastery** = weighted average of its branches, weighted by branch popularity.
- Displayed as 0–100 with bands: Learning (<40), Familiar (40–70), Solid (70–90),
  Mastered (90+). Branch view uses these as a heat map so weak branches are visible
  at a glance.
- **Progress history**: snapshot per-opening mastery daily (on first open) into a small
  time series for the dashboard chart.

---

## 6. Build order (milestones)

Each milestone is independently usable — stop anywhere and still have a working tool.

**M1 — Board + content core (usable as an opening browser)**
- Vite + React + TS PWA scaffold, installable, offline-capable.
- Board with legal moves (chess.js + chessground), move list.
- Tree data model + IndexedDB persistence + JSON export/import.
- **Content pipeline v1** (Node script): Lichess catalog + Explorer deepening + engine
  evals + mechanical explanations → bundled JSON. Start with one ECO section to validate
  the pipeline end-to-end, then run for all.
- Catalog browser: search/filter all openings, toggle into the active training set,
  step through any line on the board.
- Repertoire editor v1 (extend/customize shipped trees, mark move kinds, edit annotations).

**M2 — Practice mode**
- Drill loop: opponent sampling (theory + mistakes), deviation detection, feedback panel
  with explanation + next-moves preview, forced-correct-move reinforcement, line-complete
  card.

**M3 — SRS + tracking**
- Per-node SM-2 scheduling, due queue, session scoping.
- Branch/opening mastery scores, dashboard with progress rings, heat-map branch view,
  daily snapshots + history chart.

**M4 — Engine features**
- Stockfish WASM worker; eval bar in practice (cached evals + live on deviation).
- Explorer/theory calculator with top-3 lines, repertoire overlay, add-to-repertoire.
- Eval precomputation pass in the editor; end-of-theory eval stamping.

**M5 — Content quality + polish**
- Claude API enrichment pass in the content pipeline (human-quality explanations),
  re-run and re-bundle.
- Hesitation timing, refutation-drill mode, weakest-branches list, streaks.
- PGN import/export round-trip with a real Lichess study.
- Live Lichess Explorer lookup in the Explorer screen (online-only, graceful offline).

---

## 7. Decisions made (so Claude Code doesn't re-ask)

- PWA over native; no backend; all data on-device in IndexedDB with JSON backup.
- Opponent only ever plays in-tree moves during practice; free play lives in Explorer.
- **All standard openings ship pre-loaded**, generated by the build-time content pipeline
  (Lichess catalog + Explorer deepening + Stockfish evals + generated explanations). The
  editor customizes; it is not a prerequisite for training.
- "Clearly winning" is set automatically by the pipeline (eval passes ±1.5, theory runs
  out, or max ply), overridable per line in the editor.
- Explanations are pipeline-generated (mechanical from engine data at minimum, Claude-
  enriched in M5), stored as static content; hand-editing always wins over generated text.
- SM-2-style scheduling; exact scoring formula is an implementation detail but must
  satisfy the monotonicity/decay properties in §5.
- Practice is strict by default: mistakes force the correct move to be physically played,
  and a line with any mistake replays (same opponent moves) until passed clean before the
  session moves on. Only first attempts feed SRS scheduling.

## 8. Open questions (fine to defaults, flag if changed)

- Pipeline tuning: popularity threshold (~2%), mistake eval cutoff (~0.7), max ply (~24),
  end-of-theory eval (±1.5) — start with these, adjust after seeing real tree sizes.
- Which rating band of the Lichess pool to use for mistake popularity (default: 1600–2000,
  roughly the opponents a club player actually faces).
- Hesitation threshold and exact SRS constants — tune after real use.
- Explorer API rate limits may make the full pipeline run take hours — acceptable for a
  one-time build; cache raw API responses on disk so re-runs are cheap.
