import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import QRCode from "qrcode";
import { executeQuery } from "@/lib/graphql/execute";
import { AdmissionPassDocument } from "@/lib/graphql/generated";
import { QRPassCard } from "@/components/qr-pass-card";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { AdmissionPass } from "@/lib/types";

interface Props {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ orderId?: string }>;
}

export default async function AdmissionPage({ params, searchParams }: Props) {
  const { ticketId } = await params;
  const { orderId } = await searchParams;

  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const data = await executeQuery(
    AdmissionPassDocument,
    { ticketId, orderId: orderId ?? null },
    { cookie: cookieStore.toString() }
  ).catch(() => notFound());

  if (!data.admissionPass) {
    notFound();
  }

  const raw = data.admissionPass;
  const pass: AdmissionPass = {
    id: raw.id,
    ticketId: raw.ticketId,
    orderId: raw.orderId,
    eventId: raw.eventId,
    status: raw.status as "ISSUED" | "USED" | "REVOKED" | "EXPIRED",
    issuedAt: raw.issuedAt,
    usedAt: raw.usedAt ?? undefined,
    qrToken: raw.qrToken ?? undefined,
  };

  const qrDataUrl = pass.qrToken
    ? `data:image/svg+xml;utf8,${encodeURIComponent(
        await QRCode.toString(pass.qrToken, { type: "svg", margin: 1, width: 320 })
      )}`
    : null;

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6">
      <Link
        href={`/tickets/${ticketId}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "gap-1.5 text-muted-foreground hover:text-foreground self-start -ml-2 text-xs"
        )}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to ticket
      </Link>

      <h1 className="text-2xl font-display font-extrabold tracking-tight">Your Admission Pass</h1>
      <QRPassCard pass={pass} qrDataUrl={qrDataUrl} />
    </div>
  );
}
