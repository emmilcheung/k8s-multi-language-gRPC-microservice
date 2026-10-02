// L-2: the Connected apps section of /settings (spec F8). A user must be able
// to recognise which app holds a grant: dynamic clients register as a UUID, so
// the registered NAME has to be what is shown, and revoke has to target the
// client, not a single session.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const serverApiMock = vi.fn();
vi.mock("@/lib/api", () => ({
  serverApi: (...args: unknown[]) => serverApiMock(...args),
}));

import {
  getConnectedApps,
  revokeConnectedAppAction,
  type ConnectedApp,
} from "@/app/settings/connected-apps";
import { ConnectedApps } from "@/app/settings/ConnectedApps";

const UUID = "7d1f6c0e-3b52-4b8e-9d0a-2f6a1c9e4b11";

describe("getConnectedApps (L-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("L-2: a dynamic client carries its registered name, not its UUID", async () => {
    serverApiMock.mockResolvedValueOnce([
      {
        clientId: UUID,
        clientName: "Claude Code",
        scope: "tickets:read orders:read",
        sessionId: "s1",
        lastRotatedAt: "2026-10-01T10:00:00.000Z",
      },
    ]);

    const { apps, error } = await getConnectedApps();

    expect(error).toBeUndefined();
    expect(serverApiMock).toHaveBeenCalledWith("/oauth/clients");
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Claude Code");
    expect(apps[0].name).not.toBe(UUID);
  });

  it("L-2: falls back to the client id when the listing carries no name", async () => {
    serverApiMock.mockResolvedValueOnce([
      { clientId: UUID, scope: "tickets:read", sessionId: "s1", lastRotatedAt: "2026-10-01T10:00:00.000Z" },
    ]);

    const { apps } = await getConnectedApps();

    expect(apps[0].name).toBe(UUID);
  });

  it("L-2: merges one client's sessions into one row, because revoke removes all of them", async () => {
    serverApiMock.mockResolvedValueOnce([
      { clientId: "c1", clientName: "Agent", scope: "tickets:read", sessionId: "s1", lastRotatedAt: "2026-10-02T10:00:00.000Z" },
      { clientId: "c1", clientName: "Agent", scope: "orders:read tickets:read", sessionId: "s2", lastRotatedAt: "2026-10-01T10:00:00.000Z" },
      { clientId: "c2", clientName: "Other", scope: "venues:read", sessionId: "s3", lastRotatedAt: "2026-09-01T10:00:00.000Z" },
    ]);

    const { apps } = await getConnectedApps();

    expect(apps.map((a) => a.clientId)).toEqual(["c1", "c2"]);
    expect(apps[0].scopes).toEqual(["tickets:read", "orders:read"]);
    expect(apps[0].lastUsedAt).toBe("2026-10-02T10:00:00.000Z");
  });

  it("L-2: reports a load failure instead of pretending the user has no connected apps", async () => {
    serverApiMock.mockRejectedValueOnce(new Error("boom"));

    const result = await getConnectedApps();

    expect(result.apps).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe("revokeConnectedAppAction (L-2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("I-7: DELETEs /oauth/clients?client_id= with the id URL-encoded, so a URL id never sits in a path segment", async () => {
    serverApiMock.mockResolvedValueOnce(undefined);
    const form = new FormData();
    form.set("clientId", "https://app.example.com/oauth/client.json");

    const result = await revokeConnectedAppAction(form);

    expect(result).toEqual({});
    expect(serverApiMock).toHaveBeenCalledWith(
      "/oauth/clients?client_id=https%3A%2F%2Fapp.example.com%2Foauth%2Fclient.json",
      { method: "DELETE" },
    );
    expect(String(serverApiMock.mock.calls[0][0])).not.toMatch(/\/oauth\/clients\/./);
  });

  it("I-7: an opaque id is sent the same way", async () => {
    serverApiMock.mockResolvedValueOnce(undefined);
    const form = new FormData();
    form.set("clientId", UUID);
    await revokeConnectedAppAction(form);
    expect(serverApiMock).toHaveBeenCalledWith(`/oauth/clients?client_id=${UUID}`, { method: "DELETE" });
  });

  it("L-2: refuses to call upstream without a client id", async () => {
    const result = await revokeConnectedAppAction(new FormData());

    expect(result.error).toBeTruthy();
    expect(serverApiMock).not.toHaveBeenCalled();
  });

  it("L-2: surfaces an upstream failure", async () => {
    serverApiMock.mockRejectedValueOnce(new Error("nope"));
    const form = new FormData();
    form.set("clientId", "c1");

    expect((await revokeConnectedAppAction(form)).error).toBe("nope");
  });
});

describe("ConnectedApps section (L-2)", () => {
  const app: ConnectedApp = {
    clientId: UUID,
    name: "Claude Code",
    isFirstParty: false,
    scopes: ["tickets:read", "orders:create"],
    lastUsedAt: "2026-10-01T10:00:00.000Z",
  };

  it("L-2: shows the app name and scopes, never the bare UUID as the title", () => {
    render(<ConnectedApps apps={[app]} revokeAction={vi.fn()} />);

    const row = screen.getByText("Claude Code").closest("[data-testid='connected-app']") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText("tickets:read")).toBeInTheDocument();
    expect(within(row).getByText("orders:create")).toBeInTheDocument();
    expect(within(row).getByText(/last used/i)).toBeInTheDocument();
  });

  it("L-2: shows the domain when the listing provides one", () => {
    render(<ConnectedApps apps={[{ ...app, domain: "claude.ai" }]} revokeAction={vi.fn()} />);

    expect(screen.getByText("claude.ai")).toBeInTheDocument();
  });

  it("L-2: each row has a Revoke form carrying its client id", () => {
    const { container } = render(<ConnectedApps apps={[app]} revokeAction={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Revoke access for Claude Code" })).toBeInTheDocument();
    const hidden = container.querySelector("input[name='clientId']") as HTMLInputElement;
    expect(hidden.value).toBe(UUID);
  });

  it("L-2: renders an empty state and a load-error state", () => {
    const { rerender } = render(<ConnectedApps apps={[]} revokeAction={vi.fn()} />);
    expect(screen.getByText(/no connected apps/i)).toBeInTheDocument();

    rerender(<ConnectedApps apps={[]} error="Could not load" revokeAction={vi.fn()} />);
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/no connected apps/i)).not.toBeInTheDocument();
  });

  it("R3: Revoke is disabled while its request is in flight (no double DELETE)", async () => {
    const revoke = vi.fn(() => new Promise<void>(() => {}));
    render(<ConnectedApps apps={[app]} revokeAction={revoke} />);

    const button = screen.getByRole("button", { name: "Revoke access for Claude Code" });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("Connected apps domain and party marker (I-7 / ruling 7)", () => {
  const base: ConnectedApp = { clientId: "c", name: "Agent", isFirstParty: false, scopes: [] };

  it("a CIMD app shows the host of its client_id, labelled as the app address", () => {
    render(
      <ConnectedApps
        apps={[{ ...base, domain: "app.example.com", domainSource: "client_id" }]}
        revokeAction={vi.fn()}
      />,
    );
    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByTestId("domain-source")).toHaveTextContent("app address");
  });

  it("a DCR app shows the redirect host, labelled as where it redirects, never as an identity", () => {
    render(
      <ConnectedApps
        apps={[{ ...base, domain: "cb.example.org", domainSource: "redirect_uri" }]}
        revokeAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("domain-source")).toHaveTextContent("redirects to");
  });

  it("marks a static app first-party and a DCR/CIMD app third-party", () => {
    const { rerender } = render(<ConnectedApps apps={[{ ...base, isFirstParty: true }]} revokeAction={vi.fn()} />);
    expect(screen.getByTestId("party-badge")).toHaveTextContent("First-party");
    rerender(<ConnectedApps apps={[base]} revokeAction={vi.fn()} />);
    expect(screen.getByTestId("party-badge")).toHaveTextContent("Third-party");
  });

  it("getConnectedApps maps the domain, its source and the party flag from the listing", async () => {
    serverApiMock.mockResolvedValueOnce([
      {
        clientId: "https://app.example.com/c.json",
        clientName: "Ex",
        clientDomain: "app.example.com",
        domainSource: "client_id",
        isFirstParty: false,
        scope: "tickets:read",
        sessionId: "s",
        lastRotatedAt: "2026-10-01T10:00:00.000Z",
      },
    ]);
    const { apps } = await getConnectedApps();
    expect(apps[0]).toMatchObject({ domain: "app.example.com", domainSource: "client_id", isFirstParty: false });
  });
});
