// Vertical white/black advantage bar (DESIGN.md §3, §4.3): sits on the board's left
// edge in Practice, OpeningView, and Explorer. Pure presentational component — height
// is controlled entirely by the parent's CSS (see evalbar.css's .board-eval-row, which
// stretches this to match the board-frame it sits beside).

import "./evalbar.css";

export interface EvalBarProps {
  /** White-positive centipawns; null = no eval available yet (neutral state). */
  evalCp: number | null;
  /** White-positive "moves to mate" (positive = White mates, negative = White gets
   *  mated). When set and non-zero, overrides evalCp for the fill/label (a mate score
   *  pins the bar to 0/100%, not wherever its clamped cp-equivalent would land). */
  mateIn?: number | null;
}

/** 50%..100%/0% "white's share" of the bar, sigmoid-mapped from cp so big swings
 *  compress instead of instantly maxing out. Clamped to [5, 95] except mate, which is
 *  a hard 0/100 (DESIGN §4.3). Null (no eval yet) renders as a flat neutral 50. */
function whiteSharePercent(evalCp: number | null, mateIn: number | null): number | null {
  if (mateIn != null && mateIn !== 0) return mateIn > 0 ? 100 : 0;
  if (evalCp == null) return null;
  const raw = 50 + 50 * (2 / (1 + Math.exp(-evalCp / 400)) - 1);
  return Math.min(95, Math.max(5, raw));
}

function formatLabel(evalCp: number | null, mateIn: number | null): string | null {
  if (mateIn != null && mateIn !== 0) {
    return `${mateIn > 0 ? "" : "-"}#M${Math.abs(mateIn)}`;
  }
  if (evalCp == null) return null;
  const pawns = evalCp / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(1)}`;
}

export default function EvalBar({ evalCp, mateIn = null }: EvalBarProps) {
  const share = whiteSharePercent(evalCp, mateIn ?? null);
  const isNeutral = share == null;
  const label = formatLabel(evalCp, mateIn ?? null);

  return (
    <div className={`eval-bar ${isNeutral ? "eval-bar-neutral" : ""}`}>
      <div className="eval-bar-track">
        <div className="eval-bar-white-fill" style={{ height: `${isNeutral ? 50 : share}%` }} />
      </div>
      <div className="eval-bar-label">{label ?? "–"}</div>
    </div>
  );
}
