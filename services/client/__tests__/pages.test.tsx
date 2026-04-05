// __tests__/pages.test.tsx — Unit tests for async Server Component pages.
//
// Strategy: call the async page function directly and render the returned JSX
// with @testing-library/react. All Next.js runtime APIs and data modules are
// mocked so no network or filesystem access occurs.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TicketPage } from "@/app/actions/tickets";
import type { Ticket } from "@/lib/types";

// ── Next.js shims ──────────────────────────────────────────────────────────────

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn(),
}));

// cookies() returns a store-like object; tests override per-case via cookieStoreMock
const cookieStoreMock = { get: vi.fn() };
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(cookieStoreMock),
}));

// react.cache is a no-op in tests — just call the wrapped function directly
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn };
});

// ── Data module mocks ──────────────────────────────────────────────────────────

const fetchTicketPageMock = vi.fn<() => Promise<TicketPage>>();
vi.mock("@/app/actions/tickets", () => ({
  fetchTicketPage: (...args: unknown[]) => fetchTicketPageMock(...args as Parameters<typeof fetchTicketPageMock>),
  updateTicket: vi.fn(),
  attachSeatingPlan: vi.fn(),
  detachSeatingPlan: vi.fn(),
}));

const serverApiMock = vi.fn<() => Promise<Ticket>>();
vi.mock("@/lib/api", () => ({
  serverApi: (...args: unknown[]) => serverApiMock(...args as Parameters<typeof serverApiMock>),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));

// ── Component mocks (keep tests focused on page logic, not child UI) ───────────

vi.mock("@/components/ticket-grid", () => ({
  TicketGrid: ({ initialTickets }: { initialTickets: Ticket[] }) => (
    <div data-testid="ticket-grid" data-count={initialTickets.length} />
  ),
}));

vi.mock("@/components/ticket-form", () => ({
  TicketForm: () => <div data-testid="ticket-form" />,
}));

vi.mock("@/components/purchase-button", () => ({
  PurchaseButton: ({ ticketId }: { ticketId: string }) => (
    <button data-testid="purchase-button" data-ticket-id={ticketId}>
      Purchase
    </button>
  ),
}));

vi.mock("@/components/attach-seating-plan-form", () => ({
  AttachSeatingPlanForm: () => <div data-testid="attach-seating-plan-form" />,
}));

// lucide-react icons — render as bare spans to avoid SVG parse overhead
vi.mock("lucide-react", () => ({
  Ticket: () => <span />,
  ArrowRight: () => <span />,
  Tag: () => <span />,
  Zap: () => <span />,
  Shield: () => <span />,
  Globe: () => <span />,
  ArrowLeft: () => <span />,
  User: () => <span />,
  ShieldCheck: () => <span />,
  MapPin: () => <span />,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-uuid-1",
    title: "Concert Night",
    price: "49.99",
    userId: "owner-uuid",
    orderId: null,
    version: 1,
    ...overrides,
  };
}

/** Build a base64url-encoded JWT with the given sub claim. */
function makeJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `header.${payload}.signature`;
}

// ── HomePage ──────────────────────────────────────────────────────────────────

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the hero heading", async () => {
    fetchTicketPageMock.mockResolvedValue({ tickets: [], cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    expect(screen.getByRole("heading", { level: 1, name: /find your/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /next show/i })).toBeInTheDocument();
  });

  it("renders TicketGrid with the fetched tickets", async () => {
    const tickets = [makeTicket(), makeTicket({ id: "ticket-uuid-2" })];
    fetchTicketPageMock.mockResolvedValue({ tickets, cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    const grid = screen.getByTestId("ticket-grid");
    expect(grid).toBeInTheDocument();
    expect(grid.getAttribute("data-count")).toBe("2");
  });

  it("shows available ticket count when tickets exist", async () => {
    const tickets = [makeTicket(), makeTicket({ id: "t2", orderId: "order-1" })];
    fetchTicketPageMock.mockResolvedValue({ tickets, cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    // availableCount = 1 (one ticket has no orderId)
    expect(screen.getByText(/1\s*listings/)).toBeInTheDocument();
  });

  it("shows hasMore '+' indicator when there are more pages", async () => {
    const tickets = [makeTicket()];
    fetchTicketPageMock.mockResolvedValue({ tickets, cursor: "cursor-abc", hasMore: true });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    expect(screen.getByText(/1\s*\+\s*listings/)).toBeInTheDocument();
  });

  it("falls back gracefully when fetchTicketPage rejects", async () => {
    fetchTicketPageMock.mockRejectedValue(new Error("network error"));

    const { default: HomePage } = await import("@/app/page");
    // Should not throw — page catches and defaults to empty state
    const jsx = await HomePage();
    render(jsx);

    const grid = screen.getByTestId("ticket-grid");
    expect(grid.getAttribute("data-count")).toBe("0");
  });
});

// ── TicketDetailPage ──────────────────────────────────────────────────────────

describe("TicketDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no auth cookie
    cookieStoreMock.get.mockReturnValue(undefined);
  });

  const params = Promise.resolve({ ticketId: "ticket-uuid-1" });

  it("shows ticket title and price", async () => {
    serverApiMock.mockResolvedValue(makeTicket());

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Concert Night"
    );
    // Price appears in both the info panel and the purchase panel
    expect(screen.getAllByText("$49.99").length).toBeGreaterThanOrEqual(1);
  });

  it("calls notFound() when the API throws", async () => {
    serverApiMock.mockRejectedValue(new Error("404"));

    const { notFound } = await import("next/navigation");
    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );

    await expect(TicketDetailPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("shows TicketForm when the viewer is the owner and ticket is not reserved", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    serverApiMock.mockResolvedValue(ticket);
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByTestId("ticket-form")).toBeInTheDocument();
    expect(screen.queryByTestId("purchase-button")).not.toBeInTheDocument();
  });

  it("shows 'cannot be edited' message when owner views reserved ticket", async () => {
    const ticket = makeTicket({ userId: "owner-uuid", orderId: "order-1" });
    serverApiMock.mockResolvedValue(ticket);
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.queryByTestId("ticket-form")).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited/i)).toBeInTheDocument();
  });

  it("shows PurchaseButton for a signed-in buyer on an available ticket", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    serverApiMock.mockResolvedValue(ticket);
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByTestId("purchase-button")).toBeInTheDocument();
    expect(
      screen.getByTestId("purchase-button").getAttribute("data-ticket-id")
    ).toBe("ticket-uuid-1");
  });

  it("shows 'Sign in to Purchase' link for an unauthenticated buyer", async () => {
    serverApiMock.mockResolvedValue(makeTicket({ userId: "owner-uuid" }));
    cookieStoreMock.get.mockReturnValue(undefined);

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    const link = screen.getByRole("link", { name: /sign in to purchase/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/auth/signin");
  });

  it("shows 'Already Reserved' disabled button for a buyer on a reserved ticket", async () => {
    const ticket = makeTicket({ userId: "owner-uuid", orderId: "order-1" });
    serverApiMock.mockResolvedValue(ticket);
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    const btn = screen.getByRole("button", { name: /already reserved/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("falls back to purchase view (non-owner) when JWT is malformed", async () => {
    serverApiMock.mockResolvedValue(makeTicket({ userId: "owner-uuid" }));
    // Malformed token — cannot decode payload
    cookieStoreMock.get.mockReturnValue({ value: "not.a.real.jwt" });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    // currentUserId will be null after parse failure — treated as buyer
    expect(screen.queryByTestId("ticket-form")).not.toBeInTheDocument();
    // Shows sign-in link because token cookie value is truthy but userId is null...
    // Actually: token is truthy → PurchaseButton should render (not sign-in link)
    // because the `token` variable itself is truthy even if decode fails.
    expect(screen.getByTestId("purchase-button")).toBeInTheDocument();
  });
});
