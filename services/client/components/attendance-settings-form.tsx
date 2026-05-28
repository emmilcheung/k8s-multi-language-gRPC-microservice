"use client";

import { useState, type FormEvent } from "react";
import { updateAttendancePolicyAction } from "@/app/actions/attendance-policy";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { AttendanceCheckInItem, AttendanceSettings, AttendanceSummary } from "@/lib/types";

interface AttendanceSettingsFormProps {
  eventId: string;
  initialSettings: AttendanceSettings;
  summary?: AttendanceSummary | null;
  checkIns?: AttendanceCheckInItem[];
  buyerEmailsByUserID?: Record<string, string>;
  locked?: boolean;
}

export function AttendanceSettingsForm({
  eventId,
  initialSettings,
  summary,
  checkIns = [],
  buyerEmailsByUserID = {},
  locked = false,
}: AttendanceSettingsFormProps) {
  const [requireQrForEntry, setRequireQrForEntry] = useState(initialSettings.requireQrForEntry);
  const [allowManualOverride, setAllowManualOverride] = useState(initialSettings.allowManualOverride);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const result = await updateAttendancePolicyAction(eventId, { requireQrForEntry, allowManualOverride });
      if (result.error) {
        setError(result.error);
      } else if (result.policy) {
        setRequireQrForEntry(result.policy.requireQrForEntry);
        setAllowManualOverride(result.policy.allowManualOverride);
        setSaved(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save attendance settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card border border-line rounded-lg p-6 flex flex-col gap-5 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Attendance settings</h2>
        <p className="text-sm text-mute">Control QR admission requirements for this event.</p>
      </div>

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="require-qr">Require QR for entry</Label>
          <input
            id="require-qr"
            type="checkbox"
            checked={requireQrForEntry}
            disabled={locked}
            onChange={(e) => setRequireQrForEntry(e.target.checked)}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="allow-manual">Allow manual override</Label>
          <input
            id="allow-manual"
            type="checkbox"
            checked={allowManualOverride}
            disabled={locked}
            onChange={(e) => setAllowManualOverride(e.target.checked)}
          />
        </div>

        <Button type="submit" disabled={saving || locked}>
          {saving ? "Saving…" : "Save Settings"}
        </Button>
        {locked && (
          <p className="text-xs text-mute">
            Attendance settings are locked because this ticket already has completed sales.
          </p>
        )}
      </form>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-emerald-500">Settings saved.</p>}

      {summary && (
        <div className="border-t border-line pt-4 text-sm text-mute flex flex-wrap gap-4">
          <span>{summary.totalAdmitted} admitted</span>
          <span>{summary.totalDenied} denied</span>
          <span>{summary.totalCheckedIn} checked in</span>
        </div>
      )}

      <div className="border-t border-line pt-4 flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Checked-in attendees</h3>
        {checkIns.length === 0 ? (
          <p className="text-sm text-mute">No attendees checked in yet.</p>
        ) : (
          <ul className="text-sm text-mute space-y-1">
            {checkIns.map((entry) => {
              const userLabel = entry.buyerUserId
                ? (buyerEmailsByUserID[entry.buyerUserId] ?? entry.buyerUserId)
                : "Unknown buyer";
              return (
                <li key={entry.credentialId}>
                  <span className="text-ink">{userLabel}</span>
                  {entry.checkedInAt ? ` · ${new Date(entry.checkedInAt).toLocaleString()}` : ""}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
