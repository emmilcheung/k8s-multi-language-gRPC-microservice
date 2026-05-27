"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, QrCode, ShieldAlert, XCircle } from "lucide-react";
import { scanCheckIn, scanCheckInByEmail } from "@/app/actions/attendance";
import type { ScannerResponse } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface ScannerClientProps {
  eventId: string;
  eventTitle?: string;
  venueName?: string;
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
  if (!result) return "border-line bg-subtle text-mute";
  if (result === "valid") return "border-ok/30 bg-ok-soft text-ok";
  if (result === "already_used" || result === "revoked") return "border-warn/30 bg-warn-soft text-warn";
  return "border-bad/30 bg-bad-soft text-bad";
}

function resultMessage(result: ScannerResponse["result"]): string {
  switch (result) {
    case "valid":
      return "Welcome — please proceed";
    case "already_used":
      return "This pass was already admitted.";
    case "not_found":
      return "No admission credential found for this attendee.";
    case "revoked":
      return "This credential is revoked or expired.";
    case "policy_block":
      return "Manual check-in is disabled by organizer policy.";
    case "wrong_event":
      return "This credential belongs to a different event.";
    case "invalid_signature":
      return "The QR token is invalid.";
    default:
      return `Check-in result: ${result}`;
  }
}

function getScanState(result: ScannerResponse | null) {
  if (!result) {
    return {
      label: "READY",
      description: "Hold a pass to the camera",
      icon: QrCode,
    };
  }

  if (result.result === "valid") {
    return {
      label: "ADMITTED",
      description: resultMessage(result.result),
      icon: CheckCircle2,
    };
  }

  if (result.result === "already_used" || result.result === "revoked") {
    return {
      label: "ALREADY USED",
      description: resultMessage(result.result),
      icon: ShieldAlert,
    };
  }

  return {
    label: "INVALID",
    description: resultMessage(result.result),
    icon: XCircle,
  };
}

export function ScannerClient({ eventId, eventTitle, venueName }: ScannerClientProps) {
  const [manualEntryEnabled, setManualEntryEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [gateLabel, setGateLabel] = useState("GATE");
  const [deviceId, setDeviceId] = useState("scanner-web-local");
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<ScannerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);

  const scanState = getScanState(result);
  const StateIcon = scanState.icon;
  const eventLabel = eventTitle ? `${eventTitle}${venueName ? ` · ${venueName}` : ""}` : eventId;

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
    const storedGateLabel = window.sessionStorage.getItem("scanner.gateLabel") ?? "GATE";
    window.sessionStorage.setItem("scanner.gateLabel", storedGateLabel);
    setGateLabel(storedGateLabel);

    const existingDeviceId = window.sessionStorage.getItem("scanner.deviceId");
    if (existingDeviceId) {
      setDeviceId(existingDeviceId);
      return () => {
        stopCamera();
      };
    }

    const freshDeviceId = `gate-${storedGateLabel}-${crypto.randomUUID()}`;
    window.sessionStorage.setItem("scanner.deviceId", freshDeviceId);
    setDeviceId(freshDeviceId);

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
    <div className="overflow-hidden rounded-2xl border border-line bg-background">
      <div className="flex flex-col gap-3 border-b border-line bg-card px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-ink">{eventLabel}</p>
            <Badge tone="ok" dot>
              Live
            </Badge>
          </div>
          <p className="text-xs text-mute">{gateLabel} · web scanner · staff device</p>
        </div>
        <div className="space-y-1 text-right">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-mute">Device ID</p>
          <span data-testid="scanner-device-id" className="font-mono text-xs text-mute">
            {deviceId}
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex flex-col items-center justify-center gap-6 bg-subtle/40 px-6 py-10">
          <div className="flex h-[420px] w-full max-w-[520px] items-center justify-center rounded-[28px] border border-line bg-card p-8 shadow-[0_0_80px_rgba(58,79,255,0.08)]">
            <div className="relative h-full w-full overflow-hidden rounded-[22px] border border-line bg-ink">
              <video
                ref={videoRef}
                className={cn("h-full w-full object-cover transition-opacity", cameraActive ? "opacity-100" : "opacity-0")}
                playsInline
                muted
                autoPlay
              />
              {!cameraActive && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center text-white/80">
                  <QrCode className="size-24 text-accent" />
                  <p className="max-w-xs text-sm">{scanState.description}</p>
                </div>
              )}
              <div className="pointer-events-none absolute inset-8 rounded-[18px] border-2 border-accent/80" />
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className={cn("inline-flex items-center gap-3 rounded-full border px-6 py-3", resultTone(result?.result))}>
              <StateIcon className="size-5" />
              <span className="text-xl font-semibold tracking-[0.16em]">{scanState.label}</span>
            </div>
            <p className="text-sm text-mute">{scanState.description}</p>
          </div>

          <div className="flex flex-wrap justify-center gap-3">
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

          {cameraError ? <p className="text-xs text-destructive">{cameraError}</p> : null}
        </section>

        <aside className="space-y-4 border-t border-line bg-card px-6 py-6 lg:border-l lg:border-t-0">
          <div className="rounded-2xl border border-line bg-background">
            <div className="border-b border-line px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-mute">Last scan</p>
            </div>
            <div className="space-y-3 px-4 py-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span className="text-mute">Result</span>
                <span className={cn("rounded-full border px-2 py-1 text-xs font-semibold", resultTone(result?.result))}>
                  {scanState.label}
                </span>
              </div>
              <div className="flex items-start justify-between gap-4">
                <span className="text-mute">Event</span>
                <span className="text-right text-ink">{eventLabel}</span>
              </div>
              <div className="flex items-start justify-between gap-4">
                <span className="text-mute">Credential</span>
                <span className="text-right font-mono text-xs text-ink">
                  {result?.credentialId ?? "Awaiting scan"}
                </span>
              </div>
              <div className="flex items-start justify-between gap-4">
                <span className="text-mute">Status</span>
                <span className="text-right text-ink">{result?.status ?? "Not checked in"}</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-background p-4">
            <div className="mb-4 flex flex-col gap-1.5">
              <Label htmlFor="gate-label">Gate label</Label>
              <Input
                id="gate-label"
                value={gateLabel}
                onChange={(e) => {
                  const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") || "GATE";
                  setGateLabel(next);
                  window.sessionStorage.setItem("scanner.gateLabel", next);
                }}
                onBlur={(e) => {
                  const label = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") || "GATE";
                  const fresh = `gate-${label}-${crypto.randomUUID()}`;
                  setDeviceId(fresh);
                  window.sessionStorage.setItem("scanner.deviceId", fresh);
                }}
                placeholder="e.g. MAIN, NORTH, VIP"
              />
            </div>

            <form onSubmit={onTokenSubmit} className="flex flex-col gap-3">
              {manualEntryEnabled ? (
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
              ) : (
                <p className="text-xs text-mute">
                  Manual token entry is available as a fallback when camera scanning is unavailable.
                </p>
              )}
            </form>
          </div>

          <form onSubmit={onEmailSubmit} className="flex flex-col gap-3 rounded-2xl border border-line bg-background p-4">
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
              <p className="text-xs text-mute">
                Use this when the attendee lost their QR token. Check-in succeeds only if this buyer purchased this ticket.
              </p>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Checking in…" : "Check In by Email"}
            </Button>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </aside>
      </div>
    </div>
  );
}
