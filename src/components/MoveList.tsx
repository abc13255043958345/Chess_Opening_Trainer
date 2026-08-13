// Horizontal-wrap numbered move list ("1. e4 e5 2. Nf3 …"). Tap any move to jump to it.

import "../screens/screens.css";

export interface MoveListProps {
  /** SAN moves from the start of the line, in order (no numbering). */
  sans: string[];
  /** 0 = before the first move; 1 = after sans[0]; etc. */
  currentPly: number;
  onSelect: (ply: number) => void;
}

export default function MoveList({ sans, currentPly, onSelect }: MoveListProps) {
  if (sans.length === 0) {
    return <div className="move-list move-list-empty text-dim">Start of the line.</div>;
  }

  return (
    <div className="move-list">
      {sans.map((san, i) => {
        const ply = i + 1;
        const moveNumber = Math.floor(i / 2) + 1;
        const isWhiteMove = i % 2 === 0;
        return (
          <span className="move-list-item-group" key={ply}>
            {isWhiteMove && <span className="move-list-num">{moveNumber}.</span>}
            <button
              type="button"
              className={`move-list-move ${ply === currentPly ? "active" : ""}`}
              onClick={() => onSelect(ply)}
            >
              {san}
            </button>
          </span>
        );
      })}
    </div>
  );
}
