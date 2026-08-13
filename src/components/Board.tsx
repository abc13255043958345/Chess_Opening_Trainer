// Thin controlled wrapper around chessground v9 (see node_modules/chessground/README.md
// and dist/*.d.ts — inspected directly to confirm this API/CSS shape).
//
// - One chessground instance per mount: created in an effect, destroyed on unmount.
// - Every render re-syncs the instance to the current props via cg.set(...); chessground
//   diffs internally so this is cheap and is also what lets a caller force a visual
//   "snap back" after an illegal drop (re-render with unchanged fen still re-applies it).
// - chessground does NOT derive whose turn it is from the FEN string (fen.ts only reads
//   piece placement) — turnColor has to be computed and passed explicitly, or movable
//   pieces silently refuse to move.

import { useEffect, useRef } from "react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { Color as CgColor, Dests, Key } from "chessground/types";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "../screens/screens.css";

export interface BoardProps {
  fen: string;
  orientation: "white" | "black";
  lastMove?: [string, string];
  viewOnly?: boolean;
  /** Legal targets by origin square; when provided, only these squares are movable. */
  dests?: Map<string, string[]>;
  onMove?: (orig: string, dest: string) => void;
  check?: boolean;
  /** Briefly tints the board frame red/green (e.g. wrong/correct move feedback in
   *  Practice mode). Purely visual — no effect on movability. Unset/null = no tint. */
  flash?: "red" | "green" | null;
}

function turnColorFromFen(fen: string): CgColor {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function buildConfig(props: BoardProps): Config {
  const { fen, orientation, lastMove, viewOnly = false, dests, onMove, check } = props;
  const turnColor = turnColorFromFen(fen);
  return {
    fen,
    orientation,
    turnColor,
    check: check ?? false,
    // NEVER chessground's own viewOnly: when true at CREATION time, bindBoard()
    // (chessground/dist/events.js) returns before attaching the touchstart/mousedown
    // handlers and set() never re-binds them — a board mounted during the opponent's
    // turn (e.g. every Black practice session) would be permanently un-draggable.
    // View-only is emulated below via movable.color/draggable/selectable, which
    // chessground checks per-event at runtime, so toggling works.
    viewOnly: false,
    coordinates: false,
    disableContextMenu: true,
    lastMove: lastMove as Key[] | undefined,
    highlight: { lastMove: true, check: true },
    animation: { enabled: true, duration: 180 },
    movable: {
      free: false,
      color: viewOnly ? undefined : turnColor,
      dests: (viewOnly ? new Map() : dests) as unknown as Dests | undefined,
      showDests: true,
      events: {
        after: (orig, dest) => onMove?.(orig, dest),
      },
    },
    premovable: { enabled: false },
    predroppable: { enabled: false },
    draggable: { enabled: !viewOnly, showGhost: true },
    selectable: { enabled: !viewOnly },
    drawable: { enabled: false },
  };
}

export default function Board(props: BoardProps) {
  const { flash } = props;
  const boardElRef = useRef<HTMLDivElement>(null);
  const cgRef = useRef<Api | null>(null);

  // Mount once: create the chessground instance, destroy it on unmount.
  useEffect(() => {
    if (!boardElRef.current) return;
    const cg = Chessground(boardElRef.current, buildConfig(props));
    cgRef.current = cg;
    return () => {
      cg.destroy();
      cgRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync on every render (deliberately no dependency array): cheap, idempotent,
  // and it's what lets a caller force a re-sync (e.g. snap back after an illegal
  // drop) purely by re-rendering, even when none of the prop values actually changed.
  useEffect(() => {
    cgRef.current?.set(buildConfig(props));
  });

  return (
    <div className={`board-wrap ${flash ? `board-wrap-flash-${flash}` : ""}`}>
      <div className="board-square" ref={boardElRef} />
    </div>
  );
}
