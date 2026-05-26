import type { AdmissionPass } from "@/lib/types";
import { Badge } from "@/components/ui/badge";

interface QRPassCardProps {
  pass: AdmissionPass;
  qrDataUrl?: string | null;
}

export function QRPassCard({ pass, qrDataUrl }: QRPassCardProps) {
  const isUsed = pass.status === "USED";
  const isRevoked = pass.status === "REVOKED" || pass.status === "EXPIRED";
  const isActive = pass.status === "ISSUED";

  return (
    <div className="bg-card border border-border rounded-lg p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Admission Pass</h2>
        <Badge className={isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-muted/40 text-muted-foreground"}>
          {pass.status}
        </Badge>
      </div>

      {isUsed && <p className="text-sm text-amber-400">This pass has already been used for entry.</p>}
      {isRevoked && <p className="text-sm text-destructive">This pass is no longer valid for entry.</p>}
      {isActive && <p className="text-sm text-muted-foreground">Show this QR code at the entry gate.</p>}

      {pass.qrToken ? (
        <div className="rounded border border-border bg-muted/30 p-3">
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt="Admission QR code"
              className="w-56 h-56 rounded bg-white p-2"
              data-qr-token={pass.qrToken}
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">QR token is not available yet.</p>
      )}
    </div>
  );
}
