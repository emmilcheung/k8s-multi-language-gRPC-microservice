"use client";
// components/section-form.tsx — Client Component for adding a section to a seating plan.

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Grid3X3, AlertCircle, Loader2, Plus } from "lucide-react";
import type { PlanState } from "@/app/actions/venues";

interface SectionFormProps {
  action: (_prev: PlanState, formData: FormData) => Promise<PlanState>;
}

const initialState: PlanState = {};

export function SectionForm({ action }: SectionFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [sectionType, setSectionType] = useState<"seated" | "ga">("seated");

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">Add Section</h3>
        <p className="text-sm text-muted-foreground">Define a new section layout.</p>
      </div>

      <div className="h-px bg-white/6" />

      <form action={formAction} className="flex flex-col gap-4">
        {/* Error alert */}
        {state?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        {/* Section name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="section-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Name
          </Label>
          <div className="relative">
            <Grid3X3 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="section-name"
              name="name"
              type="text"
              required
              placeholder="Floor A"
              className="pl-9"
            />
          </div>
        </div>

        {/* Section type toggle */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Type
          </Label>
          {/* Hidden input carries the selected value */}
          <input type="hidden" name="type" value={sectionType} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSectionType("seated")}
              className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                sectionType === "seated"
                  ? "bg-primary/20 text-primary border-primary/40"
                  : "bg-transparent text-muted-foreground border-white/10 hover:border-white/20"
              }`}
            >
              Seated
            </button>
            <button
              type="button"
              onClick={() => setSectionType("ga")}
              className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                sectionType === "ga"
                  ? "bg-primary/20 text-primary border-primary/40"
                  : "bg-transparent text-muted-foreground border-white/10 hover:border-white/20"
              }`}
            >
              GA
            </button>
          </div>
        </div>

        {/* Seated-only: row / column count */}
        {sectionType === "seated" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rowCount" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Rows
              </Label>
              <Input
                id="rowCount"
                name="rowCount"
                type="number"
                min="1"
                step="1"
                required
                placeholder="10"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="columnCount" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Columns
              </Label>
              <Input
                id="columnCount"
                name="columnCount"
                type="number"
                min="1"
                step="1"
                required
                placeholder="20"
              />
            </div>
          </div>
        )}

        {/* GA: row and column count hidden (server validates 0 for GA) */}
        {sectionType === "ga" && (
          <>
            <input type="hidden" name="rowCount" value="0" />
            <input type="hidden" name="columnCount" value="0" />
          </>
        )}

        <Button
          type="submit"
          className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Adding…
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Add Section
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
