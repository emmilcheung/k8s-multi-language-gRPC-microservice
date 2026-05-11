"use client";

import { useEffect, useRef, useState } from "react";
import { scanCheckIn, scanCheckInByEmail } from "@/app/actions/attendance";
import type { ScannerResponse } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ScannerClientProps {
  eventId: string;
}

interface BarcodeDetection {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<BarcodeDetection[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

function resultTone(result?: ScannerResponse["result"]): string {
  if (!result) return "bg-muted/30 text-muted-foreground border-border";
  if (result === "valid") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (result === "already_used" || result === "revoked") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

function resultMessage(result: ScannerResponse["result"]): string {
  switch (result) {
    case "valid":
      return "Checked in.";
    case "already_used":
      return "This attendee is already checked in.";
    case "not_found":
      return "No admission credential found for this attendee.";
    case "revoked":
      return "This credential is revoked or expired.";
    case "wrong_event":
      return "This credential belongs to a different event.";
    case "invalid_signature":
      return "The QR token is invalid.";
    default:
      return `Check-in result: ${result}`;
  }
}

export function ScannerClient({ eventId }: ScannerClientProps) {
  const [manualEntryEnabled, setManualEntryEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [gateLabel, setGateLabel] = useState<string>(() => {
    if (typeof window === "undefined") return "GATE";
    return window.sessionStorage.getItem("scanner.gateLabel") ?? "GATE";
  });
  const [deviceId, setDeviceId] = useState<string>(() => {
    if (typeof window === "undefined") return "scanner-web-local";
    const existing = window.sessionStorage.getItem("scanner.deviceId");
    if (existing) return existing;
    const fresh = `gate-${window.sessionStorage.getItem("scanner.gateLabel") ?? "GATE"}-${crypto.randomUUID()}`;
    window.sessionStorage.setItem("scanner.deviceId", fresh);
    return fresh;
  });
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<ScannerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);

  function stopCamera() {
    if (frameRequestRef.current !== null) {
      cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  async function runTokenCheckIn(scanToken: string) {
    const sanitizedToken = scanToken.trim();
    if (!sanitizedToken) {
      setError("QR token is required.");
      setResult(null);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const payload = { token: sanitizedToken, eventId, deviceId };
      const response = await scanCheckIn(payload);
      setResult(response);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Check-in failed.");
    } finally {
      setPending(false);
    }
  }

  async function onTokenSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runTokenCheckIn(token);
  }

  async function onEmailSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = buyerEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      setError("Buyer email is required.");
      setResult(null);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await scanCheckInByEmail({
        eventId,
        email: normalizedEmail,
        deviceId,
      });
      setResult(response);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Email check-in failed.");
    } finally {
      setPending(false);
    }
  }

  async function startCamera() {
    setCameraError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not available in this browser.");
      return;
    }

    const BarcodeDetector = getBarcodeDetectorCtor();
    if (!BarcodeDetector) {
      setCameraError("Camera QR decoding is not supported in this browser. Use manual fallback.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stopCamera();
        setCameraError("Scanner video is not available.");
        return;
      }
      video.srcObject = stream;
      await video.play();

      detectorRef.current = new BarcodeDetector({ formats: ["qr_code"] });
      setCameraActive(true);

      const detectLoop = async () => {
        if (!streamRef.current || !videoRef.current || !detectorRef.current) {
          return;
        }
        try {
          const detections = await detectorRef.current.detect(videoRef.current);
          const scannedToken = detections.find((entry) => entry.rawValue?.trim())?.rawValue?.trim();
          if (scannedToken) {
            setToken(scannedToken);
            stopCamera();
            await runTokenCheckIn(scannedToken);
            return;
          }
        } catch {
          stopCamera();
          setCameraError("Could not decode QR from camera feed. Try manual fallback.");
          return;
        }
        frameRequestRef.current = requestAnimationFrame(() => {
          void detectLoop();
        });
      };

      frameRequestRef.current = requestAnimationFrame(() => {
        void detectLoop();
      });
    } catch {
      stopCamera();
      setCameraError("Camera permission denied or unavailable.");
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gate-label">Gate label</Label>
        <Input
          id="gate-label"
          value={gateLabel}
          onChange={(e) => {
            const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") || "GATE";
            setGateLabel(next);
            const fresh = `gate-${next}-${crypto.randomUUID()}`;
            setDeviceId(fresh);
            window.sessionStorage.setItem("scanner.gateLabel", next);
            window.sessionStorage.setItem("scanner.deviceId", fresh);
          }}
          placeholder="e.g. MAIN, NORTH, VIP"
        />
        <span data-testid="scanner-device-id" className="text-xs text-muted-foreground font-mono">{deviceId}</span>
      </div>
      <div className="rounded border border-border bg-muted/20 p-3 flex flex-col gap-3">
        <p className="text-sm">Use your device camera to scan the attendee QR code.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => {
              if (cameraActive) {
                stopCamera();
              } else {
                void startCamera();
              }
            }}
          >
            {cameraActive ? "Stop camera scan" : "Start camera scan"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setManualEntryEnabled((value) => !value)}
          >
            {manualEntryEnabled ? "Hide manual entry" : "Enter token manually"}
          </Button>
        </div>
        {cameraError && <p className="text-xs text-destructive">{cameraError}</p>}
        <video
          ref={videoRef}
          className={cameraActive ? "w-full rounded border border-border bg-black/80" : "hidden"}
          playsInline
          muted
          autoPlay
        />
      </div>

      <form onSubmit={onTokenSubmit} className="flex flex-col gap-3">
        {manualEntryEnabled && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="scanner-token">QR token</Label>
              <Input
                id="scanner-token"
                name="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                placeholder="Paste QR token if camera scan is unavailable"
              />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Checking in…" : "Check In Attendee"}
            </Button>
          </>
        )}
      </form>

      <form onSubmit={onEmailSubmit} className="rounded border border-border bg-muted/20 p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="buyer-email">Buyer email</Label>
          <Input
            id="buyer-email"
            name="buyer-email"
            type="email"
            value={buyerEmail}
            onChange={(event) => setBuyerEmail(event.target.value)}
            placeholder="buyer@example.com"
            required
          />
          <p className="text-xs text-muted-foreground">
            Use this when the attendee lost their QR token. Check-in will succeed only if this buyer purchased this ticket.
          </p>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Checking in…" : "Check In by Email"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Event ID: <span className="font-mono">{eventId}</span>
        </p>
      </form>

      <div className={`rounded border px-3 py-2 text-sm ${resultTone(result?.result ?? undefined)}`}>
        {error ? (
          <span>{error}</span>
        ) : result ? (
          <span>{resultMessage(result.result)}</span>
        ) : (
          <span>No check-in result yet.</span>
        )}
      </div>
    </div>
  );
}
