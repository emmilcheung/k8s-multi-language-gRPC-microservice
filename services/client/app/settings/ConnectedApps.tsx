import { Badge } from "@/components/ui/badge";
import { RevokeButton } from "./RevokeButton";
import type { ConnectedApp } from "./connected-apps";

const MAX_REDIRECT_HOSTS = 3;

function formatLastUsed(value?: string): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

export function ConnectedApps({
  apps,
  error,
  revokeAction,
}: {
  apps: ConnectedApp[];
  error?: string;
  revokeAction: (formData: FormData) => Promise<void>;
}) {
  if (error) {
    return (
      <p className="rounded border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (apps.length === 0) {
    return (
      <p className="rounded border border-dashed border-line p-4 text-sm text-mute">
        No connected apps.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {apps.map((app) => (
        <div
          key={app.clientId}
          data-testid="connected-app"
          className="flex flex-col gap-3 rounded border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {app.name}
              <Badge variant="outline" data-testid="party-badge">
                {app.isFirstParty ? "First-party" : "Third-party"}
              </Badge>
            </p>
            {app.addresses?.documentHost && (
              <p className="break-all text-xs text-mute" data-testid="app-document-host">
                App identity document hosted at <span className="font-mono">{app.addresses.documentHost}</span>
              </p>
            )}
            {app.addresses && app.addresses.redirectTargets.length > 0 && (
              <p className="break-all text-xs text-mute" data-testid="app-redirect-hosts">
                Redirects to{" "}
                {app.addresses.redirectTargets
                  .slice(0, MAX_REDIRECT_HOSTS)
                  .map((t) => (t.loopback ? "an app on this device" : t.host))
                  .join(", ")}
                {app.addresses.redirectTargets.length > MAX_REDIRECT_HOSTS &&
                  `, +${app.addresses.redirectTargets.length - MAX_REDIRECT_HOSTS} more`}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {app.scopes.map((scope) => (
                <Badge key={scope} variant="outline" className="font-mono">
                  {scope}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-mute">Last used: {formatLastUsed(app.lastUsedAt)}</p>
          </div>
          <form action={revokeAction}>
            <input type="hidden" name="clientId" value={app.clientId} />
            <RevokeButton appName={app.name} />
          </form>
        </div>
      ))}
    </div>
  );
}
