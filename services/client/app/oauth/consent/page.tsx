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

/** One entry of the auth-service scope registry (GET /oauth/scopes, spec C-7). */
interface ScopeInfo {
  scope: string;
  label: string;
  sensitive: boolean;
}

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
  // Labels and sensitivity come from the scope registry, so the consent text
  // can never drift from what auth-service will actually grant. If the registry
  // cannot be loaded we refuse to render rather than show unlabeled grants.
  let consent: ConsentDetails;
  let registry: ScopeInfo[];
  try {
    const [res, scopesRes] = await Promise.all([
      fetch(`${base()}/oauth/consent/${request_id}`, {
        cache: "no-store",
        headers: accessToken
          ? { Cookie: `${ACCESS_TOKEN_COOKIE}=${accessToken}` }
          : {},
      }),
      fetch(`${base()}/oauth/scopes`, { cache: "no-store" }),
    ]);
    if (res.status === 404) notFound();
    if (!res.ok || !scopesRes.ok) throw new Error(`${res.status}/${scopesRes.status}`);
    consent = (await res.json()) as ConsentDetails;
    registry = (await scopesRes.json()) as ScopeInfo[];
  } catch (err) {
    // Status codes / error message only: never log the cookie or request headers.
    console.error(
      "[consent] failed to load consent details or scope registry:",
      err instanceof Error ? err.message : String(err),
    );
    notFound();
  }

  const scopeInfo = new Map(registry.map((s) => [s.scope, s]));
  // Fail closed: a scope the registry cannot describe is treated as sensitive.
  const hasSensitive = consent.scopes.some((s) => {
    const info = scopeInfo.get(s);
    return !info || info.sensitive;
  });

  return (
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12 px-4">
      <div className="w-full max-w-md flex flex-col gap-6">

        {/* Header */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-block h-px w-6 bg-accent" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
              Authorization Request
            </span>
          </div>
          <h1 className="font-sans font-extrabold text-2xl tracking-tight text-ink">
            Allow access?
          </h1>
          <p className="text-sm text-mute">
            <span className="font-semibold text-ink">{consent.clientName}</span>
            {" "}is requesting permission to access your Marquee account.
          </p>
        </div>

        {/* Consent card */}
        <div className="bg-card border border-line rounded-lg flex flex-col gap-0 shadow-sm overflow-hidden">

          {/* Scope list */}
          <div className="px-6 py-5 flex flex-col gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-mute">
              Requested permissions
            </p>
            <ul className="flex flex-col gap-2.5">
              {consent.scopes.map((scope) => {
                const meta = scopeInfo.get(scope);
                return (
                  <li key={scope} className="flex items-start gap-3">
                    <Shield className="size-4 text-accent mt-0.5 shrink-0" />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-ink">
                        {meta ? meta.label : "Unrecognised permission"}
                      </span>
                      {!meta && (
                        <span className="text-xs font-mono text-mute break-all">{scope}</span>
                      )}
                      {(!meta || meta.sensitive) && (
                        <Badge variant="destructive" className="w-fit">
                          Sensitive
                        </Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Destructive warning */}
          {hasSensitive && (
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
              <span className="text-xs text-mute">Application</span>
              <span className="text-sm font-medium text-ink">{consent.clientName}</span>
            </div>
            <Badge variant="outline" className="text-xs font-mono text-mute">
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

        <p className="text-xs text-mute text-center">
          You can revoke access at any time from your account settings.
        </p>
      </div>
    </div>
  );
}
