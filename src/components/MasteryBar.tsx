// Hand-rolled horizontal mastery bar (DESIGN.md §3, §5, §6 M3) — used by the branch
// heat-map view (src/screens/OpeningView.tsx). Plain CSS width%, no chart lib.

import "../screens/screens.css";

export interface MasteryBarProps {
  /** 0–100. */
  value: number;
  /** Fill color — typically one of src/lib/srs.ts's bandColor() results. */
  color: string;
  /** Leading label (e.g. the branch's move SAN). */
  label?: string;
  /** Due-card count for this bar's subtree; renders a small badge when > 0. */
  due?: number;
}

export default function MasteryBar({ value, color, label, due }: MasteryBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="mastery-bar-row">
      {label && <span className="mastery-bar-label">{label}</span>}
      <div className="mastery-bar-track">
        <div className="mastery-bar-fill" style={{ width: `${clamped}%`, background: color }} />
      </div>
      <span className="mastery-bar-value">{Math.round(clamped)}</span>
      {typeof due === "number" && due > 0 && (
        <span className="badge badge-accent mastery-bar-due">{due} due</span>
      )}
    </div>
  );
}
