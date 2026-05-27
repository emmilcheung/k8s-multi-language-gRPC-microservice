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
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
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

const fetchTicketPageViaGraphQLMock = vi.fn<() => Promise<TicketPage>>();
vi.mock("@/app/actions/tickets", () => ({
  fetchTicketPageViaGraphQL: (...args: unknown[]) => fetchTicketPageViaGraphQLMock(...args as Parameters<typeof fetchTicketPageViaGraphQLMock>),
  updateTicket: vi.fn(),
}));

const executeQueryMock = vi.fn();
vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

const getSettingsDataMock = vi.fn();
const updateProfileActionMock = vi.fn();
const updatePreferencesActionMock = vi.fn();
const updateBillingAddressActionMock = vi.fn();
const revokeSessionActionMock = vi.fn();
vi.mock("@/app/actions/settings", () => ({
  getSettingsData: (...args: unknown[]) => getSettingsDataMock(...args),
  updateProfileAction: (...args: unknown[]) => updateProfileActionMock(...args),
  updatePreferencesAction: (...args: unknown[]) => updatePreferencesActionMock(...args),
  updateBillingAddressAction: (...args: unknown[]) => updateBillingAddressActionMock(...args),
  revokeSessionAction: (...args: unknown[]) => revokeSessionActionMock(...args),
}));

const serverApiMock = vi.fn<() => Promise<unknown>>();
const lookupUserMock = vi.fn();
vi.mock("@/lib/api", () => ({
  serverApi: (...args: unknown[]) => serverApiMock(...args as Parameters<typeof serverApiMock>),
  lookupUser: (...args: unknown[]) =>
    lookupUserMock(...args as Parameters<typeof lookupUserMock>),
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

vi.mock("@/components/settings-payment-methods", () => ({
  SettingsPaymentMethods: ({ initialPaymentMethods }: { initialPaymentMethods: Array<{ id: string }> }) => (
    <div data-testid="settings-payment-methods" data-count={initialPaymentMethods.length} />
  ),
}));

vi.mock("@/components/purchase-button", () => ({
  PurchaseButton: ({ ticketId }: { ticketId: string }) => (
    <button data-testid="purchase-button" data-ticket-id={ticketId}>
      Purchase
    </button>
  ),
}));

// Note: isReserved is computed in the real page but passed implicitly via purchaseGate/token logic
vi.mock("@/app/tickets/[ticketId]/_components/purchase-panel", () => ({
  PurchasePanel: (props: {
    ticket: { id: string; price: string; orderId?: string | null; reserved?: number };
    token?: string;
    isOwner: boolean;
    isSeated: boolean;
    gaMaxQuantity: number;
    purchaseGate?: { label: string };
  }) => {
    const { ticket, token, purchaseGate, isSeated } = props;
    const isReserved = Boolean(ticket.orderId) || (ticket.reserved != null && ticket.reserved > 0);

    // Calculate price in dollars
    const priceCents = Math.round(parseFloat(ticket.price) * 100);
    const priceStr = `$${(priceCents / 100).toFixed(2)}`;

    // Render relevant content for testing
    return (
      <div data-testid="purchase-panel">
        <div>{priceStr}</div>
        {purchaseGate && (
          <button disabled>{purchaseGate.label}</button>
        )}
        {!purchaseGate && isReserved && (
          <button disabled>Already Reserved</button>
        )}
        {!purchaseGate && !isReserved && !isSeated && !token && (
          <a href="/auth/signin">Sign in to Purchase</a>
        )}
        {token && !purchaseGate && !isReserved && !isSeated && (
          <button data-testid="purchase-button" data-ticket-id={ticket.id}>
            Purchase
          </button>
        )}
        {token && !purchaseGate && !isReserved && isSeated && (
          <>
            <button>Pick seats</button>
            <button>Auto-assign</button>
          </>
        )}
      </div>
    );
  },
}));

vi.mock("@/app/tickets/[ticketId]/_components/quick-facts", () => ({
  QuickFacts: () => <div data-testid="quick-facts" />,
}));

vi.mock("@/app/tickets/[ticketId]/_components/event-countdown", () => ({
  EventCountdown: () => <div data-testid="event-countdown" />,
}));

// lucide-react icons — render as bare spans to avoid SVG parse overhead
vi.mock("@/components/scanner-client", () => ({
  ScannerClient: ({ eventId }: { eventId: string }) => (
    <div data-testid="scanner-client" data-event-id={eventId} />
  ),
}));

vi.mock("@/app/_components/browse-filters", () => ({
  default: () => <div data-testid="browse-filters">Filters</div>,
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <span />,
  Ticket: () => <span />,
  ArrowRight: () => <span />,
  Tag: () => <span />,
  Zap: () => <span />,
  Shield: () => <span />,
  Clock: () => <span />,
  CheckCircle2: () => <span />,
  XCircle: () => <span />,
  CircleDot: () => <span />,
  ShoppingBag: () => <span />,
  Globe: () => <span />,
  ArrowLeft: () => <span />,
  CreditCard: () => <span />,
  DollarSign: () => <span />,
  User: () => <span />,
  ShieldCheck: () => <span />,
  MapPin: () => <span />,
  MapPinHouse: () => <span />,
  UserRound: () => <span />,
  X: () => <span />,
  Mail: () => <span />,
  Lock: () => <span />,
  Loader2: () => <span />,
  Search: () => <span />,
  Calendar: () => <span />,
  CalendarDays: () => <span />,
  Clock3: () => <span />,
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

function makeTicketDetailGraphql(ticket: Ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    price: parseFloat(ticket.price),
    priceDecimal: ticket.price,
    userId: ticket.userId,
    orderId: ticket.orderId ?? null,
    quota: ticket.quota ?? 1,
    reserved: ticket.reserved ?? 0,
    sold: ticket.sold ?? 0,
    available:
      ticket.available ??
      Math.max((ticket.quota ?? 1) - (ticket.reserved ?? 0) - (ticket.sold ?? 0), 0),
    maxPerUser: ticket.maxPerUser ?? 1,
    ticketType:
      ticket.ticketType === "SEATED_MANUAL" || ticket.ticketType === "SEATED_AUTO"
        ? "SEATED"
        : "GENERAL_ADMISSION",
    seatingPlan: ticket.seatingPlanId ? { id: ticket.seatingPlanId } : null,
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

  it("renders the search header", async () => {
    fetchTicketPageViaGraphQLMock.mockResolvedValue({ tickets: [], cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    expect(screen.getByPlaceholderText(/search events/i)).toBeInTheDocument();
  });

  it("renders category filter buttons when tickets exist", async () => {
    const tickets = [makeTicket(), makeTicket({ id: "ticket-uuid-2" })];
    fetchTicketPageViaGraphQLMock.mockResolvedValue({ tickets, cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    // New design has category cards for Concerts, Sports, etc.
    expect(screen.getByRole("button", { name: /concerts/i })).toBeInTheDocument();
  });

  it("shows event count when tickets exist", async () => {
    const tickets = [makeTicket(), makeTicket({ id: "t2" })];
    fetchTicketPageViaGraphQLMock.mockResolvedValue({ tickets, cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    // Hero card takes first ticket; grid has 1 remaining event
    expect(screen.getByText(/1\s*events/)).toBeInTheDocument();
  });

  it("displays filter section with date, price, category, availability options", async () => {
    const tickets = [makeTicket()];
    fetchTicketPageViaGraphQLMock.mockResolvedValue({ tickets, cursor: null, hasMore: false });

    const { default: HomePage } = await import("@/app/page");
    render(await HomePage());

    // New design includes filter sidebar (visible on desktop)
    expect(screen.getByTestId("browse-filters")).toBeInTheDocument();
  });

  it("falls back gracefully when fetchTicketPageViaGraphQL rejects", async () => {
    fetchTicketPageViaGraphQLMock.mockRejectedValue(new Error("network error"));

    const { default: HomePage } = await import("@/app/page");
    // Should not throw — page catches and defaults to empty state
    const jsx = await HomePage();
    render(jsx);

    expect(screen.getByText(/no events available/i)).toBeInTheDocument();
  });
});

// ── OrdersPage ───────────────────────────────────────────────────────────────

describe("OrdersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockReset();
    serverApiMock.mockReset();
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });
  });

  it("renders the authenticated order list from GraphQL", async () => {
    executeQueryMock.mockResolvedValueOnce({
      orders: [
        {
          id: "order-uuid-1",
          userId: "buyer-uuid",
          status: "AWAITING_PAYMENT",
          quantity: 2,
          expiresAt: "2026-12-01T20:00:00Z",
          createdAt: "2026-12-01T19:00:00Z",
          ticket: {
            id: "ticket-uuid-1",
            title: "Concert Night",
            price: "49.99",
          },
        },
      ],
    });
    executeQueryMock.mockResolvedValueOnce({
      ticket: {
        event: {
          title: "Concert Night",
          startsAt: "2026-12-10T20:00:00Z",
          venueName: "Greek Theatre",
          venueAddress: null,
        },
        seatingPlan: null,
      },
    });
    serverApiMock.mockRejectedValue(new Error("OrdersPage should not use REST"));

    const { default: OrdersPage } = await import("@/app/orders/page");
    render(await OrdersPage());

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(serverApiMock).not.toHaveBeenCalledWith("/api/tickets/ticket-uuid-1");
    expect(screen.getByRole("heading", { level: 1, name: /my orders/i })).toBeInTheDocument();
    expect(screen.getByText(/1 order/i)).toBeInTheDocument();
    expect(screen.getByText("Concert Night")).toBeInTheDocument();
    expect(screen.getByText("$99.98")).toBeInTheDocument();
    expect(screen.getByText(/pay now/i)).toBeInTheDocument();
  });
});

describe("OrderDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockReset();
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });
    cookieStoreMock.toString = vi.fn(() => "token=buyer");
  });

  it("redirects expired created orders to the recovery route", async () => {
    executeQueryMock.mockResolvedValue({
      order: {
        id: "order-uuid-1",
        userId: "buyer-uuid",
        status: "CREATED",
        quantity: 2,
        expiresAt: "2020-01-01T00:00:00Z",
        createdAt: "2019-12-31T23:50:00Z",
        ticket: {
          id: "ticket-uuid-1",
          title: "Concert Night",
          price: "49.99",
        },
      },
      currentUser: {
        id: "buyer-uuid",
        paymentMethods: [],
      },
    });

    const { redirect } = await import("next/navigation");
    const { default: OrderDetailPage } = await import("@/app/orders/[orderId]/page");
    await OrderDetailPage({ params: Promise.resolve({ orderId: "order-uuid-1" }) });

    expect(redirect).toHaveBeenCalledWith("/checkout/recover?orderId=order-uuid-1");
  });
});

// ── TicketDetailPage ──────────────────────────────────────────────────────────

describe("TicketDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockReset();
    // Default: no auth cookie
    cookieStoreMock.get.mockReturnValue(undefined);
  });

  const params = Promise.resolve({ ticketId: "ticket-uuid-1" });

  it("shows ticket title and price", async () => {
    const ticket = makeTicket();
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });

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

  it("calls notFound() when the GraphQL query returns null", async () => {
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });
    executeQueryMock.mockResolvedValue({ ticket: null });

    const { notFound } = await import("next/navigation");
    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );

    await expect(TicketDetailPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  }, 10000);

  it("does not add page-level retries when ticket detail GraphQL fails transiently", async () => {
    executeQueryMock.mockRejectedValue(new Error("upstream timeout"));

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );

    await expect(TicketDetailPage({ params })).rejects.toThrow("upstream timeout");
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
  });

  it("uses ticket detail GraphQL parity fields without REST fallback", async () => {
    executeQueryMock.mockResolvedValue({
      ticket: makeTicketDetailGraphql(
        makeTicket({ userId: "owner-uuid", orderId: "order-1", reserved: 1, sold: 0 })
      ),
    });
    serverApiMock.mockRejectedValue(new Error("REST fallback should not be used"));
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(serverApiMock).not.toHaveBeenCalledWith("/api/tickets/ticket-uuid-1");
    expect(screen.queryByTestId("ticket-form")).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited/i)).toBeInTheDocument();
  });

  it("shows TicketForm when the viewer is the owner and ticket is not reserved", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByTestId("ticket-form")).toBeInTheDocument();
    expect(screen.queryByTestId("purchase-button")).not.toBeInTheDocument();
  });

  it("shows an attendance settings link for owners", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByRole("link", { name: /attendance settings/i })).toHaveAttribute(
      "href",
      "/tickets/ticket-uuid-1/attendance"
    );
  });

  it("shows 'cannot be edited' message when owner views reserved ticket", async () => {
    const ticket = makeTicket({ userId: "owner-uuid", orderId: "order-1" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.queryByTestId("ticket-form")).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited/i)).toBeInTheDocument();
  });

  it("keeps attendance navigation visible for owners on reserved tickets", async () => {
    const ticket = makeTicket({ userId: "owner-uuid", orderId: "order-1" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByRole("link", { name: /attendance settings/i })).toHaveAttribute(
      "href",
      "/tickets/ticket-uuid-1/attendance"
    );
    expect(screen.getByRole("link", { name: /open scanner console/i })).toHaveAttribute(
      "href",
      "/scan?eventId=ticket-uuid-1"
    );
  });

  it("shows PurchaseButton for a signed-in buyer on an available ticket", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByTestId("purchase-button")).toBeInTheDocument();
    expect(
      screen.getByTestId("purchase-button").getAttribute("data-ticket-id")
    ).toBe("ticket-uuid-1");
    expect(screen.queryByRole("link", { name: /view admission pass/i })).not.toBeInTheDocument();
  });

  it("does not show admission pass link when buyer has no completed order", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByTestId("purchase-button")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /view admission pass/i })).not.toBeInTheDocument();
  });

  it("shows 'Sign in to Purchase' link for an unauthenticated buyer", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
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
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
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
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
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

  it("shows scanner entry point only for owner when attendance policy requires QR", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock.mockResolvedValue({ ticket: makeTicketDetailGraphql(ticket) });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.getByRole("link", { name: /open scanner console/i })).toHaveAttribute(
      "href",
      "/scan?eventId=ticket-uuid-1"
    );
  });

  it("hides scanner entry point when attendance policy does not require QR", async () => {
    const ticket = makeTicket({ userId: "owner-uuid" });
    executeQueryMock
      .mockResolvedValueOnce({ ticket: makeTicketDetailGraphql(ticket) })
      .mockResolvedValueOnce({ attendancePolicy: { eventId: "ticket-uuid-1", requireQrForEntry: false, allowManualOverride: false } });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: TicketDetailPage } = await import(
      "@/app/tickets/[ticketId]/page"
    );
    render(await TicketDetailPage({ params }));

    expect(screen.queryByRole("link", { name: /open scanner console/i })).not.toBeInTheDocument();
  });
});

describe("AttendanceSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupUserMock.mockReset();
    lookupUserMock.mockResolvedValue({ user: { id: "buyer-uuid", email: "buyer@example.com" } });
  });

  it("redirects to sign-in when the viewer is logged out", async () => {
    cookieStoreMock.get.mockReturnValue(undefined);

    const navigation = await import("next/navigation");
    vi.mocked(navigation.redirect).mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT");
    });

    const { default: AttendanceSettingsPage } = await import(
      "@/app/tickets/[ticketId]/attendance/page"
    );

    await expect(
      AttendanceSettingsPage({ params: Promise.resolve({ ticketId: "ticket-uuid-1" }) })
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(navigation.redirect).toHaveBeenCalledWith("/auth/signin");
  });

  it("renders the policy form with settings and summary", async () => {
    executeQueryMock.mockResolvedValue({
      ticket: { id: "ticket-uuid-1", title: "Concert Night", userId: "owner-uuid", sold: 0 },
      attendancePolicy: { eventId: "ticket-uuid-1", requireQrForEntry: true, allowManualOverride: false },
      attendanceSummary: { eventId: "ticket-uuid-1", totalAdmitted: 7, totalDenied: 2, totalCheckedIn: 7 },
      eventCheckins: [],
    });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: AttendanceSettingsPage } = await import(
      "@/app/tickets/[ticketId]/attendance/page"
    );
    render(await AttendanceSettingsPage({ params: Promise.resolve({ ticketId: "ticket-uuid-1" }) }));

    expect(screen.getByRole("heading", { level: 1, name: /attendance settings/i })).toBeInTheDocument();
    expect(screen.getByText(/7 admitted/i)).toBeInTheDocument();
    expect(screen.getByText(/2 denied/i)).toBeInTheDocument();
  });

  it("calls notFound when a logged-in non-owner opens attendance settings", async () => {
    executeQueryMock.mockResolvedValue({
      ticket: { id: "ticket-uuid-1", title: "Concert Night", userId: "owner-uuid", sold: 0 },
      attendancePolicy: { eventId: "ticket-uuid-1", requireQrForEntry: true, allowManualOverride: false },
      attendanceSummary: { eventId: "ticket-uuid-1", totalAdmitted: 0, totalDenied: 0, totalCheckedIn: 0 },
      eventCheckins: [],
    });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });

    const { default: AttendanceSettingsPage } = await import(
      "@/app/tickets/[ticketId]/attendance/page"
    );

    await expect(
      AttendanceSettingsPage({ params: Promise.resolve({ ticketId: "ticket-uuid-1" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("locks attendance requirement controls after tickets are sold", async () => {
    executeQueryMock.mockResolvedValue({
      ticket: { id: "ticket-uuid-1", title: "Concert Night", userId: "owner-uuid", sold: 1 },
      attendancePolicy: { eventId: "ticket-uuid-1", requireQrForEntry: true, allowManualOverride: false },
      attendanceSummary: { eventId: "ticket-uuid-1", totalAdmitted: 0, totalDenied: 0, totalCheckedIn: 0 },
      eventCheckins: [],
    });
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });

    const { default: AttendanceSettingsPage } = await import(
      "@/app/tickets/[ticketId]/attendance/page"
    );
    render(await AttendanceSettingsPage({ params: Promise.resolve({ ticketId: "ticket-uuid-1" }) }));

    expect(screen.getByLabelText(/require qr for entry/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
  });
});

describe("AdmissionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });
  });

  it("renders the redesigned pass layout with event context and grouped passes", async () => {
    serverApiMock.mockResolvedValueOnce({
      id: "order-1",
      userId: "buyer-uuid",
      status: "COMPLETE",
      expiresAt: null,
      quantity: 2,
      version: 1,
      createdAt: "2026-07-26T00:00:00Z",
      updatedAt: "2026-07-26T00:00:00Z",
      orderType: "SEATED",
      planId: "plan-1",
      ticket: {
        id: "ticket-uuid-1",
        title: "Phoenix",
        price: "48.00",
      },
      seats: [
        {
          seatId: "seat-1",
          sectionId: "section-1",
          seatLabel: "A-12",
          price: "48.00",
        },
        {
          seatId: "seat-2",
          sectionId: "section-1",
          seatLabel: "A-13",
          price: "48.00",
        },
      ],
    });

    executeQueryMock
      .mockResolvedValueOnce({
        admissionPass: {
          id: "cred-1",
          ticketId: "ticket-uuid-1",
          orderId: "order-1",
          eventId: "event-uuid-1",
          status: "USED",
          issuedAt: "2026-07-26T00:00:00Z",
          usedAt: "2026-08-09T20:42:00Z",
          qrToken: "signed-token",
        },
      })
      .mockResolvedValueOnce({
        ticket: {
          id: "ticket-uuid-1",
          title: "Phoenix",
          price: "4800",
          userId: "owner-uuid",
          orderId: "order-1",
          quota: 3000,
          reserved: 0,
          sold: 1200,
          available: 1800,
          maxPerUser: 6,
          ticketType: "SEATED_MANUAL",
          seatingPlan: { id: "plan-1" },
          event: {
            title: "Phoenix",
            description: "Alpha Zulu Tour",
            startsAt: "2026-08-09T20:30:00Z",
            endsAt: "2026-08-09T23:00:00Z",
            imageUrl: null,
            venueName: "The Greek Theatre",
            venueAddress: "Berkeley, CA",
          },
        },
      });

    const { default: AdmissionPage } = await import(
      "@/app/tickets/[ticketId]/admission/page"
    );

    render(await AdmissionPage({
      params: Promise.resolve({ ticketId: "ticket-uuid-1" }),
      searchParams: Promise.resolve({ orderId: "order-1" }),
    }));

    expect(screen.getByRole("heading", { level: 1, name: "Phoenix" })).toBeInTheDocument();
    expect(screen.getAllByText(/the greek theatre/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/this order has 2 passes/i)).toBeInTheDocument();
    expect(screen.getAllByText("A-12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("A-13").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /transfer/i })).toHaveLength(2);
    expect(screen.queryByText(/qr token payload/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signed-token/i)).not.toBeInTheDocument();
  });
});

// ── ScanPage ─────────────────────────────────────────────────────────────────

import { TicketDetailDocument, AttendancePolicyDocument } from "@/lib/graphql/generated";

describe("ScanPage", () => {
  const searchParams = Promise.resolve({ eventId: "event-uuid-1" });

  beforeEach(() => {
    vi.clearAllMocks();
    executeQueryMock.mockReset();
  });

  it("renders scanner console when organizer owns the event and policy requires QR", async () => {
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });
    executeQueryMock
      .mockResolvedValueOnce({ ticket: { id: "event-uuid-1", userId: "owner-uuid" } })
      .mockResolvedValueOnce({ attendancePolicy: { requireQrForEntry: true } });

    const { default: ScanPage } = await import("@/app/scan/page");
    render(await ScanPage({ searchParams }));

    expect(screen.getByRole("heading", { level: 1, name: /scanner console/i })).toBeInTheDocument();
    expect(screen.getByTestId("scanner-client")).toHaveAttribute("data-event-id", "event-uuid-1");

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(executeQueryMock).toHaveBeenNthCalledWith(
      1,
      TicketDetailDocument,
      { id: "event-uuid-1" },
      expect.objectContaining({}),
    );
    expect(executeQueryMock).toHaveBeenNthCalledWith(
      2,
      AttendancePolicyDocument,
      { eventId: "event-uuid-1" },
      expect.objectContaining({}),
    );
  });

  it("calls notFound when the organizer ownership check fails (different userId)", async () => {
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("buyer-uuid") });
    executeQueryMock
      .mockResolvedValueOnce({ ticket: { id: "event-uuid-1", userId: "owner-uuid" } })
      .mockResolvedValueOnce({ attendancePolicy: { requireQrForEntry: true } });

    const { default: ScanPage } = await import("@/app/scan/page");
    await expect(ScanPage({ searchParams })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("calls notFound when QR policy is disabled", async () => {
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });
    executeQueryMock
      .mockResolvedValueOnce({ ticket: { id: "event-uuid-1", userId: "owner-uuid" } })
      .mockResolvedValueOnce({ attendancePolicy: { requireQrForEntry: false } });

    const { default: ScanPage } = await import("@/app/scan/page");
    await expect(ScanPage({ searchParams })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("calls notFound when no event is found", async () => {
    cookieStoreMock.get.mockReturnValue({ value: makeJwt("owner-uuid") });
    executeQueryMock
      .mockResolvedValueOnce({ ticket: null })
      .mockResolvedValueOnce({ attendancePolicy: null });

    const { default: ScanPage } = await import("@/app/scan/page");
    await expect(ScanPage({ searchParams })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
