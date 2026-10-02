// L-1: the consent page labels come from the auth-service scope registry
// (GET /oauth/scopes, spec C-7), not from a hard-coded copy that drifts, and
// sensitive scopes are called out so users notice what they hand over.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: "access-token" }) }),
}));

vi.mock("@/app/oauth/consent/ConsentActions", () => ({
  ConsentActions: () => <div data-testid="consent-actions" />,
}));

// A registry the page has never seen: if labels were hard-coded in the client,
// these would not show up.
const REGISTRY = [
  { scope: "tickets:read", label: "Browse events and tickets", sensitive: false },
  { scope: "orders:read", label: "View your orders", sensitive: false },
  { scope: "orders:create", label: "Place orders on your behalf", sensitive: true },
  { scope: "orders:cancel", label: "Cancel your orders", sensitive: true },
  { scope: "payments:read", label: "View your payments", sensitive: false },
  { scope: "payments:create", label: "Pay for orders on your behalf", sensitive: true },
  { scope: "venues:read", label: "Browse venues", sensitive: false },
  { scope: "seating:read", label: "View seat availability", sensitive: false },
  { scope: "seating:hold", label: "Hold seats for you", sensitive: false },
  { scope: "wallet:spend", label: "Spend from your wallet", sensitive: true },
];

function stubFetch(scopes: string[], registry: unknown = REGISTRY, registryOk = true) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/oauth/scopes")) {
      return new Response(JSON.stringify(registry), { status: registryOk ? 200 : 503 });
    }
    return new Response(
      JSON.stringify({
        requestId: "req-1",
        clientId: "client-1",
        clientName: "Test Agent",
        scopes,
        expiresInSeconds: 300,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderConsent() {
  const { default: ConsentPage } = await import("@/app/oauth/consent/page");
  render(await ConsentPage({ searchParams: Promise.resolve({ request_id: "req-1" }) }));
}

describe("ConsentPage scope labels (L-1)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("L-1: renders the registry label for every registry scope", async () => {
    stubFetch(REGISTRY.map((s) => s.scope));
    await renderConsent();

    for (const { label, scope } of REGISTRY) {
      expect(screen.getByText(label), `label for ${scope}`).toBeInTheDocument();
    }
  });

  it("L-1: marks sensitive scopes and not the others", async () => {
    stubFetch(["tickets:read", "orders:create", "wallet:spend"]);
    await renderConsent();

    const item = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
    expect(within(item("Place orders on your behalf")).getByText(/sensitive/i)).toBeInTheDocument();
    expect(within(item("Spend from your wallet")).getByText(/sensitive/i)).toBeInTheDocument();
    expect(within(item("Browse events and tickets")).queryByText(/sensitive/i)).not.toBeInTheDocument();
  });

  it("L-1: shows no sensitive warning for a read-only request", async () => {
    stubFetch(["tickets:read", "orders:read"]);
    await renderConsent();

    expect(screen.queryByText(/on your behalf such as/i)).not.toBeInTheDocument();
  });

  it("L-1: shows the sensitive warning when a registry-sensitive scope is requested", async () => {
    stubFetch(["wallet:spend"]);
    await renderConsent();

    expect(screen.getByText(/on your behalf such as/i)).toBeInTheDocument();
  });

  it("L-1: does not render consent when the registry cannot be loaded (never show unlabeled grants)", async () => {
    stubFetch(["orders:create"], [], false);
    const { default: ConsentPage } = await import("@/app/oauth/consent/page");

    await expect(
      ConsentPage({ searchParams: Promise.resolve({ request_id: "req-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
