// Repertoire editor v1 (DESIGN.md §4.5, §6 M1): board-driven editing of a shipped
// or already-customized tree — extend it with any legal move, mark move kinds,
// edit annotations, set end-of-theory. PGN import/export is out of scope (M5).

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Chess } from "chess.js";
import Board from "../components/Board";
import MoveList from "../components/MoveList";
import { getEngine } from "../lib/engine";
import { getTree } from "../lib/content";
import { hasUserTree, revertUserTree, saveUserTree } from "../lib/userTree";
import { pgnToTree, replayCheck, treeToPgn } from "../lib/pgn";
import {
  addMove,
  deleteSubtree,
  mainlineChild,
  pathToNode,
  sideToMove,
  validateTree,
} from "../lib/tree";
import type { TreeProblem } from "../lib/tree";
import type {
  EndOfTheory,
  Mover,
  MoveKind,
  OpeningTree,
  RepertoireNode,
} from "../types";
import "./screens.css";
import "./editor.css";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "ready" };

type SaveStatus = "saved" | "unsaved" | "saving";

const SAVE_DEBOUNCE_MS = 800;

export default function Editor() {
  const { id = "" } = useParams<{ id: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  // The working copy: a deep clone of whatever getTree() returned, so edits never
  // touch the Dexie-cached shipped ContentSection object.
  const [tree, setTree] = useState<OpeningTree | null>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string>("root");
  const [customized, setCustomized] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [problems, setProblems] = useState<TreeProblem[]>([]);
  const [warningDismissed, setWarningDismissed] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTreeRef = useRef<OpeningTree | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    setTree(null);
    (async () => {
      const loaded = await getTree(id);
      if (cancelled) return;
      if (!loaded) {
        setLoadState({ status: "not-found" });
        return;
      }
      const custom = await hasUserTree(id);
      if (cancelled) return;
      setTree(structuredClone(loaded));
      setCurrentNodeId(loaded.rootId);
      setCustomized(custom);
      setSaveStatus("saved");
      setProblems([]);
      setWarningDismissed(false);
      setLoadState({ status: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Flush any pending debounced save if the screen unmounts (e.g. navigating away)
  // before the timer fires — otherwise a last-second edit could be silently lost.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (pendingTreeRef.current) {
          saveUserTree(pendingTreeRef.current).catch(() => {});
        }
      }
    };
  }, []);

  function scheduleSave(next: OpeningTree) {
    pendingTreeRef.current = next;
    setSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const toSave = pendingTreeRef.current;
      pendingTreeRef.current = null;
      if (!toSave) return;
      setSaveStatus("saving");
      saveUserTree(toSave)
        .then(() => setSaveStatus("saved"))
        .catch(() => setSaveStatus("unsaved"));
    }, SAVE_DEBOUNCE_MS);
  }

  // The working-copy tree is privately owned by this screen (deep-cloned on load,
  // never aliased into the content cache), so mutating nodes in place and bumping
  // the top-level object identity is safe and cheap. Call after any in-place edit.
  function commitTree() {
    if (!tree) return;
    const next = { ...tree };
    setTree(next);
    setProblems(validateTree(next));
    setWarningDismissed(false);
    setCustomized(true);
    scheduleSave(next);
  }

  async function handleRevert() {
    if (!tree) return;
    if (
      !window.confirm(
        "Revert to the shipped version of this opening? Your customizations will be deleted."
      )
    )
      return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingTreeRef.current = null;
    await revertUserTree(id);
    const shipped = await getTree(id);
    if (shipped) {
      setTree(structuredClone(shipped));
      setCurrentNodeId(shipped.rootId);
      setCustomized(false);
      setProblems([]);
      setWarningDismissed(false);
      setSaveStatus("saved");
    }
  }

  if (loadState.status === "not-found") {
    return (
      <div className="screen-padding not-found">
        <p>Opening not found.</p>
        <Link to="/catalog">Back to catalog</Link>
      </div>
    );
  }

  if (loadState.status === "loading" || !tree) {
    return (
      <div className="screen-padding">
        <p className="text-dim">Loading…</p>
      </div>
    );
  }

  // Full-tree replacement for PGN import (DESIGN §4.5/§6 M5) — distinct from
  // commitTree, which re-derives state after an IN-PLACE mutation of the existing
  // working copy. Import instead swaps in an entirely new OpeningTree (same id/eco/
  // name/perspective, different nodes), so it owns setTree itself rather than routing
  // through commitTree's mutate-then-reread pattern.
  function importTree(next: OpeningTree) {
    setTree(next);
    setCurrentNodeId(next.rootId);
    setProblems(validateTree(next));
    setWarningDismissed(false);
    setCustomized(true);
    scheduleSave(next);
  }

  return (
    <EditorReady
      id={id}
      tree={tree}
      currentNodeId={currentNodeId}
      setCurrentNodeId={setCurrentNodeId}
      customized={customized}
      saveStatus={saveStatus}
      problems={problems}
      warningDismissed={warningDismissed}
      onDismissWarning={() => setWarningDismissed(true)}
      onRevert={handleRevert}
      commitTree={commitTree}
      onImportTree={importTree}
    />
  );
}

interface EditorReadyProps {
  id: string;
  tree: OpeningTree;
  currentNodeId: string;
  setCurrentNodeId: (id: string) => void;
  customized: boolean;
  saveStatus: SaveStatus;
  problems: TreeProblem[];
  warningDismissed: boolean;
  onDismissWarning: () => void;
  onRevert: () => void;
  /** Re-derive React state + schedule an autosave after any in-place tree edit. */
  commitTree: () => void;
  /** Wholesale-replace the working tree (PGN import) — see Editor()'s importTree. */
  onImportTree: (next: OpeningTree) => void;
}

function EditorReady({
  id,
  tree,
  currentNodeId,
  setCurrentNodeId,
  customized,
  saveStatus,
  problems,
  warningDismissed,
  onDismissWarning,
  onRevert,
  commitTree,
  onImportTree,
}: EditorReadyProps) {
  const currentNode = tree.nodes[currentNodeId] ?? tree.nodes[tree.rootId];

  // ---------- Eval precompute (DESIGN §4.3, §6 M4): stamp evalCp on every node
  // missing one, sequentially (depth 12, one search at a time — no point requesting
  // the engine's latest-wins cancellation here since nothing else is racing it),
  // cancellable, autosaving whatever got stamped via the existing commit flow even if
  // cancelled partway through. ----------
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalProgress, setEvalProgress] = useState<{ done: number; total: number } | null>(null);
  const evalCancelRef = useRef(false);

  async function handleRunEvals() {
    const missingIds = Object.values(tree.nodes)
      .filter((n) => typeof n.evalCp !== "number")
      .map((n) => n.id);
    if (missingIds.length === 0) return;

    setEvalRunning(true);
    evalCancelRef.current = false;
    setEvalProgress({ done: 0, total: missingIds.length });

    const engine = getEngine();
    for (let i = 0; i < missingIds.length; i++) {
      if (evalCancelRef.current) break;
      const node = tree.nodes[missingIds[i]];
      if (node) {
        try {
          const result = await engine.evaluate(node.fen, { depth: 12 });
          if (typeof result.cp === "number") node.evalCp = result.cp;
        } catch {
          // Engine failure on this node — skip it, keep going with the rest.
        }
      }
      setEvalProgress({ done: i + 1, total: missingIds.length });
    }

    commitTree();
    setEvalRunning(false);
    setEvalProgress(null);
  }

  function handleCancelEvals() {
    evalCancelRef.current = true;
  }

  // ---------- PGN import/export (DESIGN §4.5, §6 M5) ----------
  const pgnFileInputRef = useRef<HTMLInputElement>(null);
  const [pgnStatus, setPgnStatus] = useState<string | null>(null);

  function handleExportPgn() {
    const pgn = treeToPgn(tree);
    const blob = new Blob([pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tree.id}.pgn`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleImportPgnChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPgnStatus(null);

    let text: string;
    try {
      text = await file.text();
    } catch {
      setPgnStatus("Couldn't read that file.");
      return;
    }

    let parsed: OpeningTree;
    try {
      parsed = pgnToTree(text, {
        id: tree.id,
        eco: tree.eco,
        name: tree.name,
        perspective: tree.perspective,
      });
    } catch (err) {
      setPgnStatus(
        `Import failed: ${err instanceof Error ? err.message : "couldn't parse that PGN."}`
      );
      return;
    }

    const importProblems = [...validateTree(parsed), ...replayCheck(parsed)];
    const moveCount = Object.keys(parsed.nodes).length - 1;
    const warningNote =
      importProblems.length > 0
        ? ` ${importProblems.length} validation warning${importProblems.length === 1 ? "" : "s"} will show after import.`
        : "";
    const confirmed = window.confirm(
      `Replace this opening's moves with the imported PGN (${moveCount} moves)?${warningNote} This can't be undone (though "Revert to shipped" still works afterward).`
    );
    if (!confirmed) return;

    onImportTree(parsed);
    setPgnStatus(`Imported ${moveCount} moves.`);
  }

  const pathNodes = useMemo(
    () => pathToNode(tree, currentNode.id).filter((n) => n.san !== ""),
    [tree, currentNode]
  );
  const pathSans = useMemo(() => pathNodes.map((n) => n.san), [pathNodes]);

  const childNodes = useMemo(
    () =>
      currentNode.children
        .map((cid) => tree.nodes[cid])
        .filter((n): n is RepertoireNode => !!n),
    [tree, currentNode]
  );

  const nextMainline = mainlineChild(tree, currentNode);

  const lastMove: [string, string] | undefined =
    currentNode.uci.length >= 4
      ? [currentNode.uci.slice(0, 2), currentNode.uci.slice(2, 4)]
      : undefined;

  const inCheck = useMemo(() => {
    try {
      return new Chess(currentNode.fen).inCheck();
    } catch {
      return false;
    }
  }, [currentNode.fen]);

  // Unlike the viewer, every legal move is playable here — the editor is how
  // off-book lines get added to the tree in the first place.
  const dests = useMemo(() => {
    const m = new Map<string, string[]>();
    try {
      const chess = new Chess(currentNode.fen);
      for (const mv of chess.moves({ verbose: true })) {
        const arr = m.get(mv.from) ?? [];
        if (!arr.includes(mv.to)) arr.push(mv.to);
        m.set(mv.from, arr);
      }
    } catch {
      // Malformed FEN (shouldn't happen) — no legal moves offered.
    }
    return m;
  }, [currentNode.fen]);

  function goToNode(nodeId: string) {
    setCurrentNodeId(nodeId);
  }

  function handleSelectPly(ply: number) {
    const node = pathNodes[ply - 1];
    if (node) goToNode(node.id);
  }

  function handlePrev() {
    if (currentNode.parentId) goToNode(currentNode.parentId);
  }

  function handleNext() {
    if (nextMainline) goToNode(nextMainline.id);
  }

  function playMove(orig: string, dest: string) {
    let chess: Chess;
    try {
      chess = new Chess(currentNode.fen);
    } catch {
      return;
    }
    const candidates = chess
      .moves({ verbose: true })
      .filter((m) => m.from === orig && m.to === dest);
    if (candidates.length === 0) return;
    // Promotion: auto-queen for v1 (DESIGN.md §4.5 doesn't call for a picker yet).
    const mv = candidates.find((m) => m.promotion === "q") ?? candidates[0];

    const existing = childNodes.find((c) => c.uci === mv.lan);
    if (existing) {
      goToNode(existing.id);
      return;
    }

    const mover: Mover =
      sideToMove(currentNode.fen) === tree.perspective ? "user" : "opponent";
    let moveKind: MoveKind = "mainline";
    if (
      mover === "user" &&
      currentNode.children.some((cid) => tree.nodes[cid]?.moveKind === "mainline")
    ) {
      moveKind = "sideline";
    }
    const created = addMove(tree, currentNode.id, {
      san: mv.san,
      uci: mv.lan,
      fen: mv.after,
      moveKind,
    });
    commitTree();
    goToNode(created.id);
  }

  function setNodeKind(nodeId: string, kind: MoveKind) {
    const node = tree.nodes[nodeId];
    if (!node) return;
    node.moveKind = kind;
    // Invariant: a user-to-move position has at most one mainline child.
    if (kind === "mainline" && node.mover === "user" && node.parentId) {
      const parent = tree.nodes[node.parentId];
      if (parent) {
        for (const cid of parent.children) {
          if (cid === nodeId) continue;
          const sib = tree.nodes[cid];
          if (sib && sib.mover === "user" && sib.moveKind === "mainline") {
            sib.moveKind = "sideline";
          }
        }
      }
    }
    commitTree();
  }

  function setWeight(nodeId: string, pct: number | null) {
    const node = tree.nodes[nodeId];
    if (!node) return;
    if (pct == null || Number.isNaN(pct)) delete node.weight;
    else node.weight = Math.max(0, Math.min(100, pct)) / 100;
    commitTree();
  }

  function updateAnnotationField(
    nodeId: string,
    field: "explanation" | "plans",
    value: string
  ) {
    const node = tree.nodes[nodeId];
    if (!node) return;
    const explanation = field === "explanation" ? value : node.annotation?.explanation ?? "";
    const plans = field === "plans" ? value : node.annotation?.plans ?? "";
    if (explanation.trim() === "" && plans.trim() === "") {
      delete node.annotation;
    } else {
      node.annotation = {
        explanation,
        ...(plans.trim() !== "" ? { plans } : {}),
      };
    }
    commitTree();
  }

  function setEndOfTheoryReason(nodeId: string, reason: EndOfTheory["reason"] | null) {
    const node = tree.nodes[nodeId];
    if (!node) return;
    if (reason == null) {
      delete node.endOfTheory;
    } else {
      node.endOfTheory = {
        reason,
        ...(node.endOfTheory?.evalCp != null ? { evalCp: node.endOfTheory.evalCp } : {}),
      };
    }
    commitTree();
  }

  function setEndOfTheoryEval(nodeId: string, pawns: number | null) {
    const node = tree.nodes[nodeId];
    if (!node || !node.endOfTheory) return;
    if (pawns == null || Number.isNaN(pawns)) delete node.endOfTheory.evalCp;
    else node.endOfTheory.evalCp = Math.round(pawns * 100);
    commitTree();
  }

  function handleDeleteNode(nodeId: string) {
    if (nodeId === tree.rootId) return;
    if (!window.confirm("Delete this move and everything after it? This can't be undone.")) {
      return;
    }
    const node = tree.nodes[nodeId];
    const parentId = node?.parentId ?? tree.rootId;
    deleteSubtree(tree, nodeId);
    commitTree();
    goToNode(parentId);
  }

  const saveLabel =
    saveStatus === "saving" ? "Saving…" : saveStatus === "unsaved" ? "Unsaved…" : "Saved";

  return (
    <div className="editor-screen screen-padding">
      <header className="editor-header">
        <div className="opening-header-top">
          <div>
            <h1>{tree.name}</h1>
            <div className="opening-header-meta">
              <span className="badge">{tree.eco}</span>
              <span className={`badge badge-${tree.perspective}`}>
                {tree.perspective === "white" ? "White" : "Black"}
              </span>
              {customized && <span className="badge badge-customized">Customized</span>}
            </div>
          </div>
          <div className="opening-header-actions">
            <span className={`save-indicator save-indicator-${saveStatus}`}>{saveLabel}</span>
            {evalRunning ? (
              <div className="evals-running">
                <span className="text-dim">
                  Evals… {evalProgress ? `${evalProgress.done}/${evalProgress.total}` : ""}
                </span>
                <button type="button" className="evals-cancel-btn" onClick={handleCancelEvals}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="evals-btn" onClick={handleRunEvals} disabled={evalRunning}>
                Evals
              </button>
            )}
            <button
              type="button"
              className="revert-btn"
              onClick={onRevert}
              disabled={!customized}
            >
              Revert to shipped
            </button>
          </div>
        </div>
        <Link to={`/opening/${id}`} className="edit-link">
          ‹ Back to viewer
        </Link>
        <div className="pgn-actions">
          <button type="button" className="pgn-btn" onClick={handleExportPgn}>
            Export PGN
          </button>
          <button type="button" className="pgn-btn" onClick={() => pgnFileInputRef.current?.click()}>
            Import PGN
          </button>
          <input
            ref={pgnFileInputRef}
            type="file"
            accept=".pgn,text/plain,application/x-chess-pgn"
            style={{ display: "none" }}
            onChange={handleImportPgnChange}
          />
        </div>
        {pgnStatus && <p className="text-dim">{pgnStatus}</p>}
      </header>

      {problems.length > 0 && !warningDismissed && (
        <div className="warning-strip">
          <div className="warning-strip-body">
            <strong>Tree validation warnings</strong>
            <ul>
              {problems.map((p, i) => (
                <li key={i}>
                  {p.nodeId}: {p.problem}
                </li>
              ))}
            </ul>
          </div>
          <button type="button" onClick={onDismissWarning}>
            Dismiss
          </button>
        </div>
      )}

      <div className="board-frame">
        <Board
          fen={currentNode.fen}
          orientation={tree.perspective}
          lastMove={lastMove}
          dests={dests}
          onMove={playMove}
          check={inCheck}
        />
      </div>

      <MoveList sans={pathSans} currentPly={pathSans.length} onSelect={handleSelectPly} />

      <div className="nav-row">
        <button type="button" onClick={handlePrev} disabled={!currentNode.parentId}>
          ◀ Prev
        </button>
        <button type="button" onClick={handleNext} disabled={!nextMainline}>
          Next ▶
        </button>
      </div>

      {childNodes.length > 0 && (
        <div className="continuations-row">
          <div className="continuations-label">Children</div>
          <div className="chip-row">
            {childNodes.map((child) => (
              <button
                key={child.id}
                type="button"
                className={`chip continuation-chip ${
                  child.id === currentNodeId ? "chip-active" : ""
                }`}
                onClick={() => goToNode(child.id)}
              >
                {child.san}
                {child.moveKind === "opponent_mistake" && (
                  <span className="badge badge-amber">?!</span>
                )}
                {child.moveKind === "sideline" && <span className="badge badge-sideline">side</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {currentNode.id !== tree.rootId && (
        <NodePanel
          tree={tree}
          node={currentNode}
          onSetKind={setNodeKind}
          onSetWeight={setWeight}
          onUpdateAnnotation={updateAnnotationField}
          onSetEndOfTheoryReason={setEndOfTheoryReason}
          onSetEndOfTheoryEval={setEndOfTheoryEval}
          onDelete={handleDeleteNode}
        />
      )}
    </div>
  );
}

interface NodePanelProps {
  tree: OpeningTree;
  node: RepertoireNode;
  onSetKind: (nodeId: string, kind: MoveKind) => void;
  onSetWeight: (nodeId: string, pct: number | null) => void;
  onUpdateAnnotation: (nodeId: string, field: "explanation" | "plans", value: string) => void;
  onSetEndOfTheoryReason: (nodeId: string, reason: EndOfTheory["reason"] | null) => void;
  onSetEndOfTheoryEval: (nodeId: string, pawns: number | null) => void;
  onDelete: (nodeId: string) => void;
}

function NodePanel({
  node,
  onSetKind,
  onSetWeight,
  onUpdateAnnotation,
  onSetEndOfTheoryReason,
  onSetEndOfTheoryEval,
  onDelete,
}: NodePanelProps) {
  const kindOptions: { value: MoveKind; label: string }[] =
    node.mover === "opponent"
      ? [
          { value: "mainline", label: "Mainline" },
          { value: "sideline", label: "Sideline" },
          { value: "opponent_mistake", label: "Mistake" },
        ]
      : [
          { value: "mainline", label: "Mainline" },
          { value: "sideline", label: "Sideline" },
        ];

  const evalPawnsValue =
    node.endOfTheory?.evalCp != null ? (node.endOfTheory.evalCp / 100).toFixed(1) : "";
  const evalText =
    node.endOfTheory?.evalCp != null
      ? `${node.endOfTheory.evalCp >= 0 ? "+" : ""}${(node.endOfTheory.evalCp / 100).toFixed(1)}`
      : null;

  return (
    <div className="node-panel">
      <div className="node-panel-section">
        <div className="field-label">Move kind</div>
        <div className="segmented">
          {kindOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={node.moveKind === opt.value ? "active" : ""}
              onClick={() => onSetKind(node.id, opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {node.mover === "opponent" && (
        <div className="node-panel-section">
          <label className="field-label" htmlFor="node-weight">
            Weight (% of games)
          </label>
          <div className="field-with-clear">
            <input
              id="node-weight"
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              value={node.weight != null ? Math.round(node.weight * 100) : ""}
              placeholder="—"
              onChange={(e) => {
                const v = e.target.value;
                onSetWeight(node.id, v === "" ? null : Number(v));
              }}
            />
            {node.weight != null && (
              <button type="button" className="clear-btn" onClick={() => onSetWeight(node.id, null)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <div className="node-panel-section">
        <label className="field-label" htmlFor="node-explanation">
          Explanation
        </label>
        <textarea
          id="node-explanation"
          rows={3}
          placeholder="Why this move / why the alternative fails"
          value={node.annotation?.explanation ?? ""}
          onChange={(e) => onUpdateAnnotation(node.id, "explanation", e.target.value)}
        />
      </div>

      <div className="node-panel-section">
        <label className="field-label" htmlFor="node-plans">
          Plans
        </label>
        <textarea
          id="node-plans"
          rows={2}
          placeholder="Typical middlegame ideas from here"
          value={node.annotation?.plans ?? ""}
          onChange={(e) => onUpdateAnnotation(node.id, "plans", e.target.value)}
        />
      </div>

      <div className="node-panel-section">
        <div className="field-label">End of theory</div>
        <div className="segmented">
          <button
            type="button"
            className={!node.endOfTheory ? "active" : ""}
            onClick={() => onSetEndOfTheoryReason(node.id, null)}
          >
            None
          </button>
          <button
            type="button"
            className={node.endOfTheory?.reason === "clear_plan" ? "active" : ""}
            onClick={() => onSetEndOfTheoryReason(node.id, "clear_plan")}
          >
            Theory done
          </button>
          <button
            type="button"
            className={node.endOfTheory?.reason === "winning" ? "active" : ""}
            onClick={() => onSetEndOfTheoryReason(node.id, "winning")}
          >
            Clearly winning
          </button>
        </div>

        {node.endOfTheory && (
          <>
            <label className="field-label" htmlFor="node-eval">
              Eval (pawns, white-positive)
            </label>
            <div className="field-with-clear">
              <input
                id="node-eval"
                type="number"
                step="0.1"
                placeholder="e.g. 1.8"
                value={evalPawnsValue}
                onChange={(e) => {
                  const v = e.target.value;
                  onSetEndOfTheoryEval(node.id, v === "" ? null : Number(v));
                }}
              />
              {evalPawnsValue !== "" && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => onSetEndOfTheoryEval(node.id, null)}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="end-of-theory-banner">
              Theory ends:{" "}
              {node.endOfTheory.reason === "winning" ? "clearly winning" : "play chess from here"}
              {evalText ? `, ${evalText}` : ""}
            </div>
          </>
        )}
      </div>

      <button type="button" className="delete-btn" onClick={() => onDelete(node.id)}>
        Delete this move (and everything after)
      </button>
    </div>
  );
}
