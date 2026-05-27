import type { AdmissionPass } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PassCardProps {
  pass: AdmissionPass;
  qrDataUrl?: string | null;
  eventDateLabel?: string;
  title?: string;
  subtitle?: string;
  sectionLabel?: string;
  rowLabel?: string;
  seatLabel?: string;
  credentialLabel?: string;
  refreshLabel?: string;
  className?: string;
}

type StatusMeta = {
  pill: string;
  helper: string;
  pillClassName: string;
  pillDotClassName: string;
  stamp?: string;
  stampClassName?: string;
  qrMuted?: boolean;
};

const STATUS_META: Record<AdmissionPass["status"], StatusMeta> = {
  ISSUED: {
    pill: "VALID FOR ENTRY",
    helper: "Show this code at the gate",
    pillClassName: "border-emerald-300/50 bg-emerald-400/15 text-emerald-100",
    pillDotClassName: "bg-emerald-300",
  },
  USED: {
    pill: "ALREADY USED",
    helper: "Scanned at the gate",
    pillClassName: "border-white/15 bg-white/10 text-white/80",
    pillDotClassName: "bg-white/55",
    stamp: "USED",
    stampClassName: "border-white/45 text-white/80",
    qrMuted: true,
  },
  REVOKED: {
    pill: "REVOKED",
    helper: "This pass is no longer valid",
    pillClassName: "border-rose-300/50 bg-rose-400/15 text-rose-100",
    pillDotClassName: "bg-rose-300",
    stamp: "REVOKED",
    stampClassName: "border-rose-300/70 text-rose-500",
    qrMuted: true,
  },
  EXPIRED: {
    pill: "EXPIRED",
    helper: "This pass is no longer valid",
    pillClassName: "border-rose-300/50 bg-rose-400/15 text-rose-100",
    pillDotClassName: "bg-rose-300",
    stamp: "EXPIRED",
    stampClassName: "border-rose-300/70 text-rose-500",
    qrMuted: true,
  },
};

function formatUsedLabel(usedAt?: string) {
  if (!usedAt) return "Scanned at the gate";

  return `Scanned ${new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(usedAt))}`;
}

export function PassCard({
  pass,
  qrDataUrl,
  eventDateLabel = "Admission pass",
  title = "Admission Pass",
  subtitle = "Show ready for entry",
  sectionLabel = "Section TBD",
  rowLabel = "—",
  seatLabel = "—",
  credentialLabel = `cred · ${pass.id.slice(0, 4)} · ${pass.id.slice(-4)}`,
  refreshLabel = "v1 · refreshed just now",
  className,
}: PassCardProps) {
  const meta = {
    ...STATUS_META[pass.status],
    helper: pass.status === "USED" ? formatUsedLabel(pass.usedAt) : STATUS_META[pass.status].helper,
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(170deg,oklch(0.21_0.03_265)_0%,oklch(0.18_0.04_285)_55%,oklch(0.17_0.06_30)_100%)] text-white shadow-[0_20px_60px_rgb(15_23_42_/_0.25)]",
        className
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.18),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(99,102,241,0.26),transparent_35%)]" />

      <div className="relative flex items-center justify-between gap-4 px-5 pb-3 pt-5">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-full border border-white/20 text-[10px] font-semibold">
            S
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/85">
            STAGEPASS
          </span>
        </div>

        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]",
            meta.pillClassName
          )}
        >
          <span className={cn("size-1.5 rounded-full", meta.pillDotClassName)} />
          {meta.pill}
        </span>
      </div>

      <div className="relative flex flex-col gap-1 px-5 pb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
          {eventDateLabel}
        </p>
        <h2 className="text-[28px] font-semibold tracking-[-0.03em] text-white">{title}</h2>
        <p className="text-sm text-white/75">{subtitle}</p>
      </div>

      <div className="relative h-5">
        <div className="absolute -left-3 top-1/2 size-6 -translate-y-1/2 rounded-full bg-bg" />
        <div className="absolute -right-3 top-1/2 size-6 -translate-y-1/2 rounded-full bg-bg" />
        <div className="absolute left-5 right-5 top-1/2 border-t border-dashed border-white/20" />
      </div>

      <div className="relative flex flex-col items-center gap-3 px-5 pb-4 pt-4">
        <div
          className={cn(
            "relative rounded-xl bg-white p-4 shadow-[0_14px_32px_rgb(0_0_0_/_0.28)]",
            meta.qrMuted && "before:absolute before:inset-0 before:rounded-xl before:bg-white/60"
          )}
        >
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt="Admission QR code"
              className="size-56 rounded-lg bg-white p-2"
              data-qr-token={pass.qrToken}
            />
          ) : (
            <div className="flex size-56 items-center justify-center rounded-lg bg-slate-100 p-2 text-sm text-slate-500">
              QR not available
            </div>
          )}

          {meta.stamp ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span
                className={cn(
                  "rotate-[-10deg] rounded-md border-[3px] bg-white/85 px-4 py-1 text-2xl font-black uppercase tracking-[0.24em]",
                  meta.stampClassName
                )}
              >
                {meta.stamp}
              </span>
            </div>
          ) : null}
        </div>

        <p className="text-center text-xs text-white/70">{meta.helper}</p>
      </div>

      <div className="relative grid grid-cols-3 gap-3 border-t border-white/10 px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/55">Section</span>
          <span className="text-sm font-medium text-white">{sectionLabel}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/55">Row</span>
          <span className="font-mono text-sm font-medium tabular-nums text-white">{rowLabel}</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] uppercase tracking-[0.14em] text-white/55">Seat</span>
          <span className="font-mono text-sm font-medium tabular-nums text-white">{seatLabel}</span>
        </div>
      </div>

      <div className="relative flex items-center justify-between gap-3 border-t border-white/10 bg-black/20 px-5 py-3 text-[11px] text-white/65">
        <span className="font-mono tabular-nums">{credentialLabel}</span>
        <span className="font-mono tabular-nums">{refreshLabel}</span>
      </div>
    </div>
  );
}
