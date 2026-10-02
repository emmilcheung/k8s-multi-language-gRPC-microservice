import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { ConnectedApp } from "./connected-apps";

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
            <p className="text-sm font-semibold">{app.name}</p>
            {app.domain && <p className="text-xs text-mute">{app.domain}</p>}
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
            <button
              type="submit"
              className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}
            >
              Revoke
            </button>
          </form>
        </div>
      ))}
    </div>
  );
}
