"use client";

import { useState } from "react";
import { scanCheckIn, scanValidate } from "@/app/actions/attendance";
import type { ScannerResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ScanMode = "validate" | "check-in";

function resultTone(result?: ScannerResponse["result"]): string {
  if (!result) return "bg-muted/30 text-muted-foreground border-border";
  if (result === "valid") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (result === "already_used" || result === "revoked") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

export function ScannerClient() {
  const [mode, setMode] = useState<ScanMode>("validate");
  const [token, setToken] = useState("");
  const [eventId, setEventID] = useState("");
  const [deviceId, setDeviceID] = useState("scanner-web-local");
  const [result, setResult] = useState<ScannerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = { token, eventId, deviceId };
      const response = mode === "validate" ? await scanValidate(payload) : await scanCheckIn(payload);
      setResult(response);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Scan request failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={mode === "validate" ? "default" : "outline"}
          onClick={() => setMode("validate")}
        >
          Validate
        </Button>
        <Button
          type="button"
          variant={mode === "check-in" ? "default" : "outline"}
          onClick={() => setMode("check-in")}
        >
          Check-in
        </Button>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scanner-token">QR token</Label>
          <Input
            id="scanner-token"
            name="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            placeholder="Paste QR token for deterministic test flow"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scanner-event">Event ID</Label>
          <Input id="scanner-event" name="eventId" value={eventId} onChange={(e) => setEventID(e.target.value)} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scanner-device">Device ID</Label>
          <Input id="scanner-device" name="deviceId" value={deviceId} onChange={(e) => setDeviceID(e.target.value)} required />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Scanning…" : mode === "validate" ? "Validate Token" : "Check In"}
        </Button>
      </form>

      <div className={`rounded border px-3 py-2 text-sm ${resultTone(result?.result ?? undefined)}`}>
        {error ? (
          <span>{error}</span>
        ) : result ? (
          <span>
            Result: <strong>{result.result}</strong>
            {result.status ? ` · status=${result.status}` : ""}
          </span>
        ) : (
          <span>No scan result yet.</span>
        )}
      </div>
    </div>
  );
}

