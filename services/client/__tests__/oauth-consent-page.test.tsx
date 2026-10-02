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

function stubFetch(
  scopes: string[],
  registry: unknown = REGISTRY,
  registryOk = true,
  extra: Record<string, unknown> = {},
) {
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
        ...extra,
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

  it("R1: a requested scope missing from the registry fails closed (flagged sensitive, warned, raw id visible)", async () => {
    stubFetch(["tickets:read", "mystery:scope"]);
    await renderConsent();

    const item = screen.getByText("mystery:scope").closest("li") as HTMLElement;
    expect(within(item).getByText(/unrecognised permission/i)).toBeInTheDocument();
    expect(within(item).getByText(/sensitive/i)).toBeInTheDocument();
    expect(screen.getByText(/on your behalf such as/i)).toBeInTheDocument();
  });

  it("R4: logs why the registry fetch failed, without leaking the cookie", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(["orders:create"], [], false);
    const { default: ConsentPage } = await import("@/app/oauth/consent/page");

    await expect(
      ConsentPage({ searchParams: Promise.resolve({ request_id: "req-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/503/);
    expect(logged).not.toContain("access-token");
    errorSpy.mockRestore();
  });

  it("L-1: does not render consent when the registry cannot be loaded (never show unlabeled grants)", async () => {
    stubFetch(["orders:create"], [], false);
    const { default: ConsentPage } = await import("@/app/oauth/consent/page");

    await expect(
      ConsentPage({ searchParams: Promise.resolve({ request_id: "req-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("ConsentPage app addresses (R1)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const addr = (over: Record<string, unknown>) => ({
    documentHost: "app.example.com",
    redirectTargets: [{ host: "app.example.com", loopback: false }],
    redirectMismatch: false,
    ...over,
  });

  it("R1: a CIMD client shows two separate lines, the identity-document host and the redirect host, and never the word Verified", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, { addresses: addr({}), isFirstParty: false });
    await renderConsent();
    expect(screen.getByTestId("consent-document-host")).toHaveTextContent(
      "App identity document hosted at app.example.com",
    );
    expect(screen.getByTestId("consent-redirect-host")).toHaveTextContent(
      "After you allow, you are sent to app.example.com",
    );
    expect(screen.queryByTestId("consent-mismatch")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/verified/i);
    expect(screen.getByTestId("consent-party")).toHaveTextContent("Third-party");
  });

  it("R1: a redirect host that differs from the document host shows a caution naming both hosts", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, {
      addresses: addr({
        documentHost: "raw.githubusercontent.com",
        redirectTargets: [{ host: "evil.example", loopback: false }],
        redirectMismatch: true,
      }),
    });
    await renderConsent();
    const caution = screen.getByTestId("consent-mismatch");
    expect(caution).toHaveTextContent("raw.githubusercontent.com");
    expect(caution).toHaveTextContent("evil.example");
  });

  it("R1: a loopback redirect reads as an app on this device, with no caution and no raw loopback host", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, {
      addresses: addr({ redirectTargets: [{ host: "127.0.0.1", loopback: true }] }),
    });
    await renderConsent();
    const el = screen.getByTestId("consent-redirect-host");
    expect(el).toHaveTextContent("an app on this device");
    expect(el).not.toHaveTextContent("127.0.0.1");
    expect(screen.queryByTestId("consent-mismatch")).not.toBeInTheDocument();
  });

  it("R1: a DCR client has no document line, only where the code is sent", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, {
      addresses: addr({
        documentHost: undefined,
        redirectTargets: [{ host: "cb.example.org", loopback: false }],
      }),
    });
    await renderConsent();
    expect(screen.queryByTestId("consent-document-host")).not.toBeInTheDocument();
    expect(screen.getByTestId("consent-redirect-host")).toHaveTextContent("cb.example.org");
  });

  it("F2: the host lines and the caution wrap, so a long host cannot overflow the card", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, {
      addresses: addr({
        documentHost: "a".repeat(200) + ".example.com",
        redirectTargets: [{ host: "b".repeat(200) + ".example.net", loopback: false }],
        redirectMismatch: true,
      }),
    });
    await renderConsent();
    for (const id of ["consent-document-host", "consent-redirect-host", "consent-mismatch"]) {
      expect(screen.getByTestId(id)).toHaveClass("break-all");
    }
  });

  it("M-10: a very long client_id wraps instead of overflowing the card", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, {
      clientId: "https://app.example.com/" + "a".repeat(300),
    });
    await renderConsent();
    expect(screen.getByTestId("consent-client-id")).toHaveClass("break-all");
  });

  it("a static client is marked first-party", async () => {
    stubFetch(["tickets:read"], REGISTRY, true, { isFirstParty: true });
    await renderConsent();
    expect(screen.getByTestId("consent-party")).toHaveTextContent("First-party");
  });

  it("an older auth-service without the fields still renders, as third-party with no domain line", async () => {
    stubFetch(["tickets:read"]);
    await renderConsent();
    expect(screen.queryByTestId("consent-redirect-host")).not.toBeInTheDocument();
    expect(screen.getByTestId("consent-party")).toHaveTextContent("Third-party");
  });
});
