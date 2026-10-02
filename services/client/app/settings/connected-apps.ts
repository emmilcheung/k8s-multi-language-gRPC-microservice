"use server";

import { revalidatePath } from "next/cache";
import { serverApi } from "@/lib/api";

/**
 * Item of GET /oauth/clients (auth-service OAuthClientSession), one per session.
 * `clientName` is the registered name (static or dynamic client); `clientDomain`
 * is optional and only present once auth-service reports one.
 */
interface OAuthClientSession {
  clientId: string;
  clientName?: string;
  clientDomain?: string;
  scope: string;
  sessionId: string;
  lastRotatedAt: string;
}

export interface ConnectedApp {
  clientId: string;
  name: string;
  domain?: string;
  scopes: string[];
  lastUsedAt?: string;
}

/** Revoke removes every session of a client, so the listing shows one row per client. */
export async function getConnectedApps(): Promise<{ apps: ConnectedApp[]; error?: string }> {
  let sessions: OAuthClientSession[];
  try {
    sessions = await serverApi<OAuthClientSession[]>("/oauth/clients");
  } catch {
    return { apps: [], error: "Could not load connected apps." };
  }

  const byClient = new Map<string, ConnectedApp>();
  for (const s of sessions) {
    const app = byClient.get(s.clientId) ?? {
      clientId: s.clientId,
      name: s.clientName || s.clientId,
      domain: s.clientDomain,
      scopes: [],
      lastUsedAt: undefined,
    };
    for (const scope of s.scope.split(" ").filter(Boolean)) {
      if (!app.scopes.includes(scope)) app.scopes.push(scope);
    }
    if (!app.lastUsedAt || s.lastRotatedAt > app.lastUsedAt) app.lastUsedAt = s.lastRotatedAt;
    byClient.set(s.clientId, app);
  }
  return { apps: [...byClient.values()] };
}

export async function revokeConnectedAppAction(formData: FormData): Promise<{ error?: string }> {
  const clientId = formData.get("clientId");
  if (typeof clientId !== "string" || !clientId) return { error: "Client ID is required" };
  try {
    await serverApi(`/oauth/clients/${encodeURIComponent(clientId)}`, { method: "DELETE" });
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to revoke app" };
  }
}
