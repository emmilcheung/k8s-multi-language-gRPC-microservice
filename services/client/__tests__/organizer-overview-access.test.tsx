// __tests__/organizer-overview-access.test.tsx — The organizer overview offers
// each team role only what the services let that role do, and one event the
// caller may not read must not take the whole server-rendered page down.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "token" ? { value: "jwt" } : undefined),
    toString: (): string => "token=jwt",
  })),
}));

const executeQueryMock = vi.fn();
vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

vi.mock("@/components/organizer/account-switcher", () => ({
  AccountSwitcher: () => <div />,
}));

const ACME = "3f1c6d0e-5b7a-4c1e-9a52-0a1b2c3d4e5f";
const DOOR_EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "22222222-2222-4222-8222-222222222222";

function ticket(id: string, title: string) {
  return {
    id,
    title,
    sold: 3,
    priceDecimal: "20.00",
    event: { title, startsAt: "2099-01-01T20:00:00Z", venueName: "Hall" },
  };
}

type Doc = { definitions: { name?: { value: string } }[] };
const opName = (doc: unknown) => (doc as Doc).definitions[0]?.name?.value ?? "";

/** Serves the overview's queries as a member with `role`; attendance for `refused` events is denied. */
function serveAs(role: string, { eventIds = [] as string[], refused = [] as string[] } = {}) {
  executeQueryMock.mockImplementation(async (doc: unknown, vars: { id?: string }) => {
    switch (opName(doc)) {
      case "MyAccounts":
        return {
          myAccounts: [
            { role, eventIds, account: { id: ACME, name: "Acme", contactEmail: null, status: "ACTIVE" } },
          ],
        };
      case "AccountEvents":
        if (role === "DOOR_STAFF" && eventIds.length > 0) throw new Error("not allowed");
        return {
          eventsByAccount: {
            edges: [{ node: ticket(DOOR_EVENT, "Door Show") }, { node: ticket(OTHER_EVENT, "Other Show") }],
          },
        };
      case "TicketDetail":
        return { ticket: vars.id === DOOR_EVENT ? ticket(DOOR_EVENT, "Door Show") : null };
      case "AttendancePage":
        if (refused.includes(vars.id!)) throw new Error("forbidden: organizer is not allowed for this event");
        return { attendanceSummary: { totalAdmitted: 1, totalDenied: 0 } };
      default:
        throw new Error(`unexpected query ${opName(doc)}`);
    }
  });
}

const hrefs = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

async function renderOverview() {
  const { default: OrganizerPage } = await import("@/app/organizer/page");
  render(await OrganizerPage());
}

describe("Organizer overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows door staff only the events they work, with the scanner and no sales figures", async () => {
    serveAs("DOOR_STAFF", { eventIds: [DOOR_EVENT] });

    await renderOverview();

    expect(screen.getByText("Door Show")).toBeInTheDocument();
    expect(screen.queryByText("Other Show")).not.toBeInTheDocument();
    expect(hrefs()).toContain(`/scan?eventId=${DOOR_EVENT}`);
    expect(screen.queryByText(/gross sales/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/3 sold/)).not.toBeInTheDocument();
    expect(executeQueryMock.mock.calls.map(([d]) => opName(d))).not.toContain("AccountEvents");
  });

  it("does not offer finance the scanner, which the attendance service refuses them", async () => {
    serveAs("FINANCE");

    await renderOverview();

    expect(screen.getByText(/gross sales/i)).toBeInTheDocument();
    expect(hrefs()).toContain(`/organizer/events/${DOOR_EVENT}/attendance`);
    expect(hrefs().some((h) => h?.startsWith("/scan"))).toBe(false);
  });

  it("still renders when one event's attendance is refused, without links into that event", async () => {
    serveAs("ADMIN", { refused: [OTHER_EVENT] });

    await renderOverview();

    expect(screen.getByText("Other Show")).toBeInTheDocument();
    expect(hrefs()).toContain(`/scan?eventId=${DOOR_EVENT}`);
    expect(hrefs()).not.toContain(`/scan?eventId=${OTHER_EVENT}`);
    expect(hrefs()).not.toContain(`/organizer/events/${OTHER_EVENT}/attendance`);
  });

  it("gives an owner sales, attendance and the scanner for every event", async () => {
    serveAs("OWNER");

    await renderOverview();

    expect(screen.getByText(/gross sales/i)).toBeInTheDocument();
    for (const id of [DOOR_EVENT, OTHER_EVENT]) {
      expect(hrefs()).toContain(`/scan?eventId=${id}`);
      expect(hrefs()).toContain(`/organizer/events/${id}/attendance`);
    }
  });
});

describe("Venues link in the organizer console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["OWNER", "ADMIN", "EVENT_MANAGER"])("is offered to a %s, who may create venues", async (role) => {
    serveAs(role);
    const { default: OrganizerLayout } = await import("@/app/organizer/layout");
    render(await OrganizerLayout({ children: null }));

    expect(hrefs()).toContain("/venues");
  });

  it.each(["FINANCE", "DOOR_STAFF"])("is hidden from %s, who may not", async (role) => {
    serveAs(role);
    const { default: OrganizerLayout } = await import("@/app/organizer/layout");
    render(await OrganizerLayout({ children: null }));

    expect(hrefs()).not.toContain("/venues");
  });
});
