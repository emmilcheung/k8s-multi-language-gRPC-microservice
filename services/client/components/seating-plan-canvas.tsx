"use client";
// components/seating-plan-canvas.tsx — Drag-and-drop 2-D seating plan canvas.
//
// Uses @xyflow/react (React Flow v12) to render section blocks on a pannable,
// zoomable canvas.  Organizers can:
//   • Drag sections to reposition them on the canvas.
//   • Save the layout via a "Save Layout" button which calls the saveLayout
//     Server Action (PATCH /api/seating-plans/:id/layout).
//
// The component is intentionally read-only for non-draft plans.

import "@xyflow/react/dist/style.css";

import React, {
  useCallback,
  useMemo,
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
import type { Section, LayoutNode, PriceTier } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Grid3X3 } from "lucide-react";

// ─── SectionNode data ─────────────────────────────────────────────────────────

interface SectionNodeData extends Record<string, unknown> {
  section: Section;
  tone: "accent" | "ok" | "warn" | "bad";
  priceLabel: string | null;
}

// ─── SectionNode component ────────────────────────────────────────────────────

/**
 * Renders a single section block inside the React Flow canvas.
 *
 * Clean V2 "Quiet" design: colored section card showing name and price.
 * No row-level drag offsets — whole node is draggable via React Flow.
 */
const SectionNode = React.memo(function SectionNode({
  data,
}: NodeProps<Node<SectionNodeData>>) {
  const { section, tone, priceLabel } = data;

  const TONE: Record<SectionNodeData["tone"], string> = {
    accent: "bg-accent-soft border-accent/40 text-accent",
    ok: "bg-ok-soft border-ok/40 text-ok",
    warn: "bg-warn-soft border-warn/40 text-warn",
    bad: "bg-bad-soft border-bad/40 text-bad",
  };

  return (
    <div
      className={cn(
        "rounded-xl border px-5 py-4 min-w-[150px]",
        "flex flex-col items-center text-center gap-1",
        TONE[tone]
      )}
    >
      <p className="text-sm font-semibold">{section.name}</p>
      {priceLabel ? (
        <span className="text-xs text-mute font-mono tabular-nums">
          {priceLabel} / seat
        </span>
      ) : (
        <span className="text-xs text-mute font-mono tabular-nums">
          {section.type === "ga"
            ? `${section.columnCount} cap (GA)`
            : `${section.rowCount}R × ${section.columnCount}C`}
        </span>
      )}
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
  /** Available price tiers for resolving section prices. */
  tiers?: PriceTier[];
}

// Build initial React Flow node list from sections + stored layout positions.
function buildInitialNodes(
  sections: Section[],
  layout: SeatingPlanCanvasProps["initialLayout"],
  tiers: PriceTier[] = []
): Node<SectionNodeData>[] {
  const TONE_CYCLE = ["accent", "ok", "warn", "bad"] as const;

  return sections.map((section, idx) => {
    const stored = (layout?.nodes ?? []).find((n) => n.id === section.id);
    const tone = TONE_CYCLE[idx % 4];

    const tier = tiers.find((t) => t.id === section.priceTierId);
    const priceLabel = tier ? "$" + parseFloat(tier.price).toFixed(2) : null;

    return {
      id: section.id,
      type: "sectionNode",
      position: stored?.position ?? { x: 40 + idx * 220, y: 40 },
      data: {
        section,
        tone,
        priceLabel,
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
  tiers = [],
}: SeatingPlanCanvasProps) {
  // ── State ─────────────────────────────────────────────────────────────────

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // ── React Flow nodes ───────────────────────────────────────────────────────

  const initialNodes = useMemo(
    () => buildInitialNodes(sections, initialLayout, tiers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // only compute once on mount
  );

  const [nodes, setNodes] = useNodesState(initialNodes);

  const enrichedNodes = useMemo<Node<SectionNodeData>[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        draggable: isDraft,
      })),
    [nodes, isDraft]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<SectionNodeData>>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setNodes]
  );

  // ── Save handler ───────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);

    const layoutJson = {
      nodes: nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: {},
      })),
    };

    const result = await saveLayout(planId, layoutJson);
    setSaving(false);
    if (result.error) {
      setSaveError(result.error);
    } else {
      setSavedAt(new Date());
    }
  }, [planId, nodes]);

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
            Drag sections to arrange the seating layout.
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {isDraft ? "Draft (editable)" : "Published (read-only)"}
        </Badge>
      </div>

      {/* Canvas */}
      <div
        className="relative rounded-2xl overflow-hidden ring-1 ring-line/70 bg-subtle/60"
        style={{ height: 500 }}
      >
        <div className="absolute left-1/2 -translate-x-1/2 top-3 z-10 px-4 py-1 rounded-md bg-ink text-bg text-[10px] font-semibold tracking-[0.25em]">
          STAGE
        </div>
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
