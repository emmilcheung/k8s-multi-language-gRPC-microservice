import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { Shield, AlertTriangle } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ConsentActions } from "./ConsentActions";
import { base } from "@/lib/server-utils";
import {
  ACCESS_TOKEN_COOKIE,
} from "@/lib/session-cookies";

export const metadata = { title: "Authorize Access — Marquee" };

interface ConsentDetails {
  requestId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  expiresInSeconds: number;
}

/** Human-readable label + description for each OAuth scope. */
const SCOPE_LABELS: Record<string, { label: string; description: string }> = {
  "tickets:read":    { label: "View tickets",       description: "See available events and ticket listings" },
  "orders:read":     { label: "View orders",        description: "Read your order history and status" },
  "orders:create":   { label: "Create orders",      description: "Purchase tickets on your behalf" },
  "orders:cancel":   { label: "Cancel orders",      description: "Cancel existing ticket orders" },
  "payments:read":   { label: "View payments",      description: "Read your payment history" },
  "payments:create": { label: "Make payments",      description: "Initiate payments for orders" },
  "venues:read":     { label: "View venues",        description: "See venue information and seating layouts" },
  "seating:read":    { label: "View seating",       description: "Check seat availability" },
  "seating:hold":    { label: "Hold seats",         description: "Reserve seats temporarily during purchase" },
};

// searchParams is a Promise in Next.js 15 App Router
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request_id?: string }>;
}) {
  const { request_id } = await searchParams;

  if (!request_id) notFound();

  // Read the auth cookie early — required for Kong JWT check on GET
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;

  // Check if user is signed in — if not, they somehow landed here without auth
  if (!accessToken) {
    notFound();
  }

  // Fetch consent details from auth-service (JWT protected — cookie is required)
  let consent: ConsentDetails;
  try {
    const res = await fetch(`${base()}/oauth/consent/${request_id}`, {
      cache: "no-store",
      headers: accessToken
        ? { Cookie: `${ACCESS_TOKEN_COOKIE}=${accessToken}` }
        : {},
    });
    if (res.status === 404) notFound();
    if (!res.ok) throw new Error(`${res.status}`);
    consent = (await res.json()) as ConsentDetails;
  } catch {
    notFound();
  }

  const hasDestructive = consent.scopes.some((s) =>
    ["orders:create", "orders:cancel", "payments:create", "seating:hold"].includes(s),
  );

  return (
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12 px-4">
      <div className="w-full max-w-md flex flex-col gap-6">

        {/* Header */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-block h-px w-6 bg-primary" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Authorization Request
            </span>
          </div>
          <h1 className="font-display font-extrabold text-2xl tracking-tight text-foreground">
            Allow access?
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{consent.clientName}</span>
            {" "}is requesting permission to access your Marquee account.
          </p>
        </div>

        {/* Consent card */}
        <div className="bg-card border border-border rounded-lg flex flex-col gap-0 shadow-sm overflow-hidden">

          {/* Scope list */}
          <div className="px-6 py-5 flex flex-col gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Requested permissions
            </p>
            <ul className="flex flex-col gap-2.5">
              {consent.scopes.map((scope) => {
                const meta = SCOPE_LABELS[scope];
                return (
                  <li key={scope} className="flex items-start gap-3">
                    <Shield className="size-4 text-primary mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-foreground">
                        {meta?.label ?? scope}
                      </span>
                      {meta?.description && (
                        <span className="text-xs text-muted-foreground">
                          {meta.description}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Destructive warning */}
          {hasDestructive && (
            <>
              <Separator />
              <div className="px-6 py-4 flex items-start gap-3 bg-amber-500/5 border-y border-amber-500/20">
                <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  This app will be able to take actions on your behalf such as
                  purchasing tickets or making payments.
                </p>
              </div>
            </>
          )}

          <Separator />

          {/* App identity */}
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">Application</span>
              <span className="text-sm font-medium text-foreground">{consent.clientName}</span>
            </div>
            <Badge variant="outline" className="text-xs font-mono text-muted-foreground">
              {consent.clientId}
            </Badge>
          </div>

          <Separator />

          {/* Actions */}
          <div className="px-6 py-5">
            <ConsentActions
              requestId={consent.requestId}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          You can revoke access at any time from your account settings.
        </p>
      </div>
    </div>
  );
}
