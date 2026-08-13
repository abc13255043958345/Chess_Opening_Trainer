// Hand-rolled SVG donut for mastery display (DESIGN.md §3, §5, §6 M3). No chart lib —
// just a background track circle plus a foreground arc drawn via stroke-dasharray,
// rotated so the arc starts at 12 o'clock. See src/screens/screens.css's
// ".progress-ring*" rules for the overlay-label layout.

import "../screens/screens.css";

export interface ProgressRingProps {
  /** 0–100. */
  value: number;
  /** Outer diameter in px. */
  size?: number;
  /** Arc color — typically one of src/lib/srs.ts's bandColor() results. */
  color: string;
  /** Small caption under the numeric value (e.g. "overall"). */
  label?: string;
}

export default function ProgressRing({ value, size = 64, color, label }: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const stroke = Math.max(4, size * 0.11);
  const radius = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const center = size / 2;

  return (
    <div className="progress-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="progress-ring-label">
        <span className="progress-ring-value">{Math.round(clamped)}</span>
        {label && <span className="progress-ring-caption">{label}</span>}
      </div>
    </div>
  );
}
