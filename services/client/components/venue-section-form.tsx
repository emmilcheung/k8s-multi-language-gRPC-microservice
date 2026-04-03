"use client";
// components/venue-section-form.tsx — Client component for managing venue template sections.
// Displays existing sections (with delete buttons) and an inline form to add new ones.

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Grid3X3, AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import type { VenueState } from "@/app/actions/venues";
import type { VenueSection } from "@/lib/types";

type BoundDeleteAction = (_prev: VenueState, _formData: FormData) => Promise<VenueState>;

interface SectionWithAction {
  section: VenueSection;
  deleteAction: BoundDeleteAction;
}

interface VenueSectionFormProps {
  addAction: (_prev: VenueState, formData: FormData) => Promise<VenueState>;
  sections: SectionWithAction[];
}

const initialState: VenueState = {};

export function VenueSectionForm({ addAction, sections }: VenueSectionFormProps) {
  const [addState, addFormAction, addPending] = useActionState(addAction, initialState);
  const [sectionType, setSectionType] = useState<"seated" | "ga">("seated");

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">Venue Layout Template</h3>
        <p className="text-sm text-muted-foreground">
          Define the physical seating structure once. Every event plan created for this venue will automatically get its own independent inventory from this template.
        </p>
      </div>

      {/* Existing sections list */}
      {sections.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sections.map(({ section, deleteAction }) => (
            <VenueSectionRow key={section.id} section={section} deleteAction={deleteAction} />
          ))}
        </ul>
      )}

      <div className="h-px bg-white/6" />

      {/* Add section form */}
      <form action={addFormAction} className="flex flex-col gap-4">
        {addState?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{addState.error}</span>
          </div>
        )}

        {/* Section name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vs-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Section name
          </Label>
          <div className="relative">
            <Grid3X3 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input id="vs-name" name="name" type="text" required placeholder="Floor A" className="pl-9" />
          </div>
        </div>

        {/* Type toggle */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</Label>
          <input type="hidden" name="type" value={sectionType} />
          <div className="flex gap-2">
            {(["seated", "ga"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSectionType(t)}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                  sectionType === t
                    ? "bg-primary/20 text-primary border-primary/40"
                    : "bg-transparent text-muted-foreground border-white/10 hover:border-white/20"
                }`}
              >
                {t === "seated" ? "Seated" : "GA"}
              </button>
            ))}
          </div>
        </div>

        {/* Seated: rows × columns */}
        {sectionType === "seated" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-rows" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Rows
              </Label>
              <Input id="vs-rows" name="rowCount" type="number" min="1" step="1" required placeholder="10" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-cols" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Columns
              </Label>
              <Input id="vs-cols" name="columnCount" type="number" min="1" step="1" required placeholder="20" />
            </div>
          </div>
        )}

        {/* GA: capacity */}
        {sectionType === "ga" && (
          <>
            <input type="hidden" name="rowCount" value="0" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vs-cap" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Capacity
              </Label>
              <Input id="vs-cap" name="columnCount" type="number" min="1" step="1" required placeholder="500" />
            </div>
          </>
        )}

        <Button type="submit" variant="outline" className="w-full gap-2" disabled={addPending}>
          {addPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" />Adding…</>
          ) : (
            <><Plus className="w-4 h-4" />Add Section</>
          )}
        </Button>
      </form>
    </div>
  );
}

// ── Row with inline delete ─────────────────────────────────────────────────────

function VenueSectionRow({
  section,
  deleteAction,
}: {
  section: VenueSection;
  deleteAction: (_prev: VenueState, _formData: FormData) => Promise<VenueState>;
}) {
  const [, formAction, pending] = useActionState(deleteAction, {});

  return (
    <li className="flex items-center justify-between rounded-xl bg-white/4 px-3 py-2.5 text-sm gap-3">
      <span className="flex items-center gap-2 min-w-0">
        <Grid3X3 className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="font-medium truncate">{section.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">
          {section.type === "seated"
            ? `${section.rowCount}R × ${section.columnCount}C`
            : `GA · ${section.columnCount} cap`}
        </span>
      </span>
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          aria-label={`Remove ${section.name}`}
          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
        >
          {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </form>
    </li>
  );
}
