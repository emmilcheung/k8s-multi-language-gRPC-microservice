"use client";
// components/seating-plan-canvas.tsx — Drag-and-drop 2-D seating plan canvas.
//
// Uses @xyflow/react (React Flow v12) to render section blocks on a pannable,
// zoomable canvas.  Organizers can:
//   • Drag sections to reposition them on the canvas.
//   • For SEATED sections: drag individual row strips left/right to set row offsets
//     (enables curved / staggered row layouts).
//   • Save the layout via a "Save Layout" button which calls the saveLayout
//     Server Action (PATCH /api/seating-plans/:id/layout).
//
// The component is intentionally read-only for non-draft plans.

import "@xyflow/react/dist/style.css";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { saveLayout } from "@/app/actions/venues";
import type { Section, LayoutNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Grid3X3, Move } from "lucide-react";

// ─── SectionNode data ─────────────────────────────────────────────────────────

interface SectionNodeData extends Record<string, unknown> {
  section: Section;
  isDraft: boolean;
  rowOffsets: Record<string, number>;
  onRowOffsetChange: (rowIndex: number, dx: number) => void;
}

// ─── SectionNode component ────────────────────────────────────────────────────

/**
 * Renders a single section block inside the React Flow canvas.
 *
 * SEATED sections show a grid of labelled row strips; each row strip is
 * horizontally draggable so organisers can stagger rows to create curved layouts.
 *
 * GA sections render as a solid coloured block showing section capacity.
 */
const SectionNode = React.memo(function SectionNode({
  data,
}: NodeProps<Node<SectionNodeData>>) {
  const { section, isDraft, rowOffsets, onRowOffsetChange } = data;
  const isSeated = section.type === "seated";

  // ── Per-row drag state ────────────────────────────────────────────────────
  const rowDragRef = useRef<{
    rowIndex: number;
    startX: number;
    startOffset: number;
  } | null>(null);

  const handleRowPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, rowIndex: number) => {
      if (!isDraft) return;
      e.stopPropagation(); // prevent React Flow node drag
      e.currentTarget.setPointerCapture(e.pointerId);
      rowDragRef.current = {
        rowIndex,
        startX: e.clientX,
        startOffset: rowOffsets[String(rowIndex)] ?? 0,
      };
    },
    [isDraft, rowOffsets]
  );

  const handleRowPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!rowDragRef.current) return;
      const { rowIndex, startX, startOffset } = rowDragRef.current;
      const dx = e.clientX - startX;
      onRowOffsetChange(rowIndex, startOffset + dx);
    },
    [onRowOffsetChange]
  );

  const handleRowPointerUp = useCallback(() => {
    rowDragRef.current = null;
  }, []);

  // ── Row rendering ─────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    if (!isSeated) return null;
    return Array.from({ length: section.rowCount }, (_, i) => {
      const offset = rowOffsets[String(i)] ?? 0;
      const rowLabel = String.fromCharCode(65 + i); // A, B, C…
      return (
        <div
          key={i}
          className={cn(
            "flex items-center gap-1 select-none",
            isDraft && "cursor-ew-resize"
          )}
          style={{ transform: `translateX(${offset}px)` }}
          onPointerDown={(e) => handleRowPointerDown(e, i)}
          onPointerMove={handleRowPointerMove}
          onPointerUp={handleRowPointerUp}
        >
          <span className="text-[10px] text-mute w-4 shrink-0 text-right font-mono">
            {rowLabel}
          </span>
          <div className="flex gap-px">
            {Array.from({ length: section.columnCount }, (_, j) => (
              <div
                key={j}
                className="w-3.5 h-3.5 rounded-sm bg-accent/30 ring-1 ring-accent/20"
              />
            ))}
          </div>
        </div>
      );
    });
  }, [
    isSeated,
    section.rowCount,
    section.columnCount,
    rowOffsets,
    isDraft,
    handleRowPointerDown,
    handleRowPointerMove,
    handleRowPointerUp,
  ]);

  return (
    <div
      className={cn(
        "glass rounded-xl p-3 min-w-[140px] max-w-[360px]",
        "ring-1 ring-line shadow-sm",
        isSeated ? "bg-accent/5" : "bg-violet-500/10"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center justify-center w-6 h-6 rounded-md bg-accent/15 ring-1 ring-accent/20 shrink-0">
          <Grid3X3 className="w-3.5 h-3.5 text-accent" />
        </div>
        <p className="text-xs font-semibold truncate flex-1">{section.name}</p>
        {isDraft && (
          <Move className="w-3 h-3 text-mute shrink-0 opacity-60" />
        )}
      </div>

      <Badge
        className={cn(
          "text-[10px] mb-2",
          isSeated
            ? "bg-accent/15 text-accent border-accent/20"
            : "bg-violet-500/15 text-violet-300 border-violet-500/20"
        )}
      >
        {section.type.toUpperCase()}
      </Badge>

      {isSeated ? (
        <div className="flex flex-col gap-0.5 mt-1">{rows}</div>
      ) : (
        <div className="flex items-center justify-center rounded-lg bg-violet-500/15 ring-1 ring-violet-500/20 h-14 mt-1">
          <p className="text-xs text-violet-300 font-medium">
              {section.columnCount > 0 ? `${section.columnCount} seats (GA)` : "GA"}
            </p>
        </div>
      )}

      <p className="text-[10px] text-mute mt-2 text-right">
        {isSeated
          ? `${section.rowCount}R × ${section.columnCount}C`
          : section.columnCount > 0 ? `${section.columnCount} cap` : "GA"}
      </p>
    </div>
  );
});

SectionNode.displayName = "SectionNode";

const nodeTypes: NodeTypes = {
  sectionNode: SectionNode as unknown as NodeTypes[string],
};

// ─── SeatingPlanCanvas ────────────────────────────────────────────────────────

interface SeatingPlanCanvasProps {
  planId: string;
  sections: Section[];
  /** Initial layout from the persisted layoutJson blob, if any. */
  initialLayout?: {
    nodes: LayoutNode[];
    viewport?: { x: number; y: number; zoom: number };
  };
  /** Whether the plan is still in draft — controls editability. */
  isDraft: boolean;
}

// Build initial React Flow node list from sections + stored layout positions.
function buildInitialNodes(
  sections: Section[],
  layout: SeatingPlanCanvasProps["initialLayout"]
): Node<SectionNodeData>[] {
  return sections.map((section, idx) => {
    const stored = (layout?.nodes ?? []).find((n) => n.id === section.id);
    return {
      id: section.id,
      type: "sectionNode",
      position: stored?.position ?? { x: 40 + idx * 220, y: 40 },
      data: {
        section,
        isDraft: true, // overridden below in component
        rowOffsets: stored?.data.rowOffsets ?? {},
        onRowOffsetChange: () => {}, // overridden below in component
      },
      draggable: true,
    };
  });
}

export function SeatingPlanCanvas({
  planId,
  sections,
  initialLayout,
  isDraft,
}: SeatingPlanCanvasProps) {
  // ── State ─────────────────────────────────────────────────────────────────
  // Row offsets are stored separately from RF nodes to avoid triggering RF
  // internal re-renders on every pointer-move during row drags.
  const [rowOffsetsMap, setRowOffsetsMap] = useState<
    Record<string, Record<string, number>>
  >(() => {
    const initial: Record<string, Record<string, number>> = {};
    (initialLayout?.nodes ?? []).forEach((n) => {
      initial[n.id] = n.data.rowOffsets ?? {};
    });
    return initial;
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // ── React Flow nodes ───────────────────────────────────────────────────────

  const initialNodes = useMemo(
    () => buildInitialNodes(sections, initialLayout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // only compute once on mount
  );

  const [nodes, setNodes] = useNodesState(initialNodes);

  // Inject current rowOffsets + isDraft + callback into each node's data
  // so SectionNode always has fresh props without full re-initialisation.
  const enrichedNodes = useMemo<Node<SectionNodeData>[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        draggable: isDraft,
        data: {
          ...n.data,
          isDraft,
          rowOffsets: rowOffsetsMap[n.id] ?? {},
          onRowOffsetChange: (rowIndex: number, newOffset: number) => {
            setRowOffsetsMap((prev) => ({
              ...prev,
              [n.id]: { ...(prev[n.id] ?? {}), [String(rowIndex)]: newOffset },
            }));
          },
        } as SectionNodeData,
      })),
    [nodes, isDraft, rowOffsetsMap, setRowOffsetsMap]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<SectionNodeData>>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setNodes]
  );

  // Keep track of whether there are unsaved changes.
  const isDirtyRef = useRef(false);
  useEffect(() => {
    isDirtyRef.current = true;
  }, [nodes, rowOffsetsMap]);

  // ── Save handler ───────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);

    const layoutJson = {
      nodes: nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: { rowOffsets: rowOffsetsMap[n.id] ?? {} },
      })),
    };

    const result = await saveLayout(planId, layoutJson);
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
    } else {
      isDirtyRef.current = false;
      setSavedAt(new Date());
    }
  }, [planId, nodes, rowOffsetsMap]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (sections.length === 0) {
    return (
      <div className="glass rounded-2xl p-10 flex flex-col items-center gap-3 text-center">
        <Grid3X3 className="w-10 h-10 text-mute" />
        <p className="text-sm text-mute">
          Add sections using the form before arranging the canvas.
        </p>
      </div>
    );
  }

  return (
    <div className="glass rounded-3xl p-6 md:p-7 flex flex-col gap-5 border border-line/70">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Plan editor</h2>
          <p className="text-xs text-mute mt-0.5">
            Drag sections to position them and offset seated rows for better sightlines.
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {isDraft ? "Draft (editable)" : "Published (read-only)"}
        </Badge>
      </div>

      {/* Canvas */}
      <div
        className="rounded-2xl overflow-hidden ring-1 ring-line/70 bg-subtle/60"
        style={{ height: 500 }}
      >
        <ReactFlow
          nodes={enrichedNodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={isDraft}
          nodesConnectable={false}
          elementsSelectable={isDraft}
          panOnDrag
          zoomOnScroll
          proOptions={{ hideAttribution: true }}
          colorMode="light"
        >
          <Background color="#cbd5e133" gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Toolbar */}
      {isDraft && (
        <div className="flex items-center gap-3 justify-end">
          {saveError && (
            <p className="text-xs text-destructive flex-1">{saveError}</p>
          )}
          {savedAt && !saveError && (
            <p className="text-xs text-mute flex-1">
              Saved {savedAt.toLocaleTimeString()}
            </p>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors",
              "bg-accent text-accent-ink hover:bg-accent/90",
              "disabled:opacity-50 disabled:pointer-events-none"
            )}
          >
            {saving ? "Saving…" : "Save Layout"}
          </button>
        </div>
      )}
    </div>
  );
}
