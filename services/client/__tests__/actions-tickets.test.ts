import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();
const authHeadersMock = vi.fn();
const cookiesMock = vi.fn();
const executeQueryMock = vi.fn();
const executeMutationMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
  authHeaders: () => authHeadersMock(),
}));

vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

import {
  createTicket,
  fetchTicketPageViaGraphQL,
  replaceInactivePlan,
  updateTicket,
} from "@/app/actions/tickets";

function ticketForm(title: string, price: string, startsAt = "2026-12-01T19:00:00Z"): FormData {
  const fd = new FormData();
  fd.set("title", title);
  fd.set("price", price);
  if (startsAt) fd.set("startsAt", startsAt);
  fd.set("requireQrForEntry", "true");
  return fd;
}

function ticketUpdateForm(title: string, price: string): FormData {
  const fd = ticketForm(title, price, "2026-12-01T19:00");
  fd.set("eventTitle", "Updated Event");
  fd.set("eventDescription", "Updated description");
  fd.set("eventImageUrl", "https://example.com/poster.png");
  fd.set("venueName", "Updated Venue");
  fd.set("venueAddress", "123 Main St");
  fd.set("endsAt", "2026-12-01T21:30");
  return fd;
}

function seatedTicketForm(
  title: string,
  price: string,
  venueId: string,
  ticketType = "SEATED_MANUAL",
  startsAt = "2026-12-01T19:00:00Z"
): FormData {
  const fd = ticketForm(title, price, startsAt);
  fd.set("ticketType", ticketType);
  fd.set("venueId", venueId);
  return fd;
}

describe("ticket server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
    cookiesMock.mockResolvedValue({ toString: () => "" });
  });

  it("createTicket validates title", async () => {
    const result = await createTicket({}, ticketForm("  ", "10"));
    expect(result).toEqual({ error: "Title is required." });
  });

  it("createTicket validates positive price", async () => {
    const result = await createTicket({}, ticketForm("Show", "0"));
    expect(result).toEqual({ error: "Price must be a positive number." });
  });

  it("createTicket returns error when GraphQL mutation rejects", async () => {
    executeMutationMock.mockRejectedValueOnce(new Error("Validation failed"));

    const result = await createTicket({}, ticketForm("Concert", "12.50"));
    expect(result).toEqual({ error: "Validation failed" });
  });

  it("createTicket redirects to created ticket on success", async () => {
    executeMutationMock.mockResolvedValueOnce({
      createTicket: { id: "ticket-1", title: "Concert", price: 1250, priceDecimal: "12.50" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      })
    );

    await createTicket({}, ticketForm("Concert", "12.50"));

    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket retries attendance settings when event projection is not ready", async () => {
    executeMutationMock.mockResolvedValueOnce({
      createTicket: { id: "ticket-1", title: "Concert", price: 1250, priceDecimal: "12.50" },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: vi.fn().mockResolvedValue({
          error: { message: "event not found" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, ticketForm("Concert", "12.50"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/attendance/events/ticket-1/settings");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:8080/api/attendance/events/ticket-1/settings");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket does not block redirect when attendance event stays unavailable", async () => {
    executeMutationMock.mockResolvedValueOnce({
      createTicket: { id: "ticket-1", title: "Concert", price: 1250, priceDecimal: "12.50" },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({
        error: { message: "event not found" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, ticketForm("Concert", "12.50"));

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links a seating plan for seated tickets", async () => {
    executeMutationMock
      .mockResolvedValueOnce({
        createTicket: { id: "ticket-1", title: "Concert", price: 1250, priceDecimal: "12.50" },
      })
      .mockResolvedValueOnce({ createSeatingPlan: { id: "plan-1", status: "DRAFT", assignmentMode: "MANUAL" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111"));

    // createTicket via GraphQL
    expect(executeMutationMock.mock.calls[0]?.[1]).toMatchObject({
      input: {
        title: "Concert",
        price: 1250,
        quota: 0,
        ticketType: "SEATED",
        event: { startsAt: "2026-12-01T19:00:00Z" },
      },
    });
    // createSeatingPlan via GraphQL
    expect(executeMutationMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        ticketId: "ticket-1",
        venueId: "11111111-1111-1111-1111-111111111111",
        name: "Concert Seating Plan",
        assignmentMode: "MANUAL",
        maxSeatsPerOrder: 10,
      },
    });
    // linkSeatingPlanToTicket stays REST
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/tickets/ticket-1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-1",
      ticketType: "SEATED_MANUAL",
    });
    // upsertAttendanceSettings stays REST
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:8080/api/attendance/events/ticket-1/settings");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requireQrForEntry: true,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links a manual seating plan for seated tickets", async () => {
    executeMutationMock
      .mockResolvedValueOnce({
        createTicket: { id: "ticket-1", title: "Concert", price: 1250, priceDecimal: "12.50" },
      })
      .mockResolvedValueOnce({ createSeatingPlan: { id: "plan-1", status: "DRAFT", assignmentMode: "MANUAL" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111"));

    expect(executeMutationMock.mock.calls[0]?.[1]).toMatchObject({
      input: { title: "Concert", price: 1250, quota: 0, ticketType: "SEATED" },
    });
    expect(executeMutationMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        ticketId: "ticket-1",
        venueId: "11111111-1111-1111-1111-111111111111",
        name: "Concert Seating Plan",
        assignmentMode: "MANUAL",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-1",
      ticketType: "SEATED_MANUAL",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:8080/api/attendance/events/ticket-1/settings");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links an auto-assigned seating plan for seated tickets", async () => {
    executeMutationMock
      .mockResolvedValueOnce({
        createTicket: { id: "ticket-2", title: "Concert", price: 1250, priceDecimal: "12.50" },
      })
      .mockResolvedValueOnce({ createSeatingPlan: { id: "plan-2", status: "DRAFT", assignmentMode: "AUTO" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({}) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket(
      {},
      seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111", "SEATED_AUTO")
    );

    expect(executeMutationMock.mock.calls[0]?.[1]).toMatchObject({
      input: { title: "Concert", price: 1250, quota: 0, ticketType: "SEATED" },
    });
    expect(executeMutationMock.mock.calls[1]?.[1]).toMatchObject({
      input: {
        ticketId: "ticket-2",
        venueId: "11111111-1111-1111-1111-111111111111",
        name: "Concert Seating Plan",
        assignmentMode: "AUTO",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-2",
      ticketType: "SEATED_AUTO",
    });
  });

  it("fetchTicketPageViaGraphQL excludes seated tickets whose plans are not active", async () => {
    executeQueryMock.mockResolvedValue({
      ticketsConnection: {
        edges: [
          {
            node: {
              id: "ga-1",
              title: "GA Ticket",
              price: 25,
              available: 50,
              ticketType: "GENERAL_ADMISSION",
              seatingPlan: null,
            },
          },
          {
            node: {
              id: "seated-draft",
              title: "Draft Seated",
              price: 55,
              available: 50,
              ticketType: "SEATED",
              seatingPlan: { id: "plan-draft" },
            },
          },
          {
            node: {
              id: "seated-active",
              title: "Active Seated",
              price: 65,
              available: 50,
              ticketType: "SEATED",
              seatingPlan: { id: "plan-active" },
            },
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "draft" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "active" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ counts: { available: 50 } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchTicketPageViaGraphQL(null);

    expect(page.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["ga-1", "seated-active"]);
  });

  it("fetchTicketPageViaGraphQL excludes seated tickets with no available seats", async () => {
    executeQueryMock.mockResolvedValue({
      ticketsConnection: {
        edges: [
          {
            node: {
              id: "seated-sold-out",
              title: "Sold Out Seated",
              price: 65,
              available: 1,
              ticketType: "SEATED",
              seatingPlan: { id: "plan-sold-out" },
            },
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "active" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ counts: { available: 0 } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchTicketPageViaGraphQL(null);

    expect(page.tickets).toEqual([]);
  });

  it("updateTicket sends event metadata via GraphQL, revalidates paths, and redirects on success", async () => {
    executeMutationMock.mockResolvedValueOnce({
      updateTicket: { id: "ticket-2", title: "Updated", price: 2000, priceDecimal: "20.00" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) })
    );

    await updateTicket("ticket-2", {}, ticketUpdateForm("Updated", "20"));

    expect(executeMutationMock.mock.calls[0]?.[1]).toMatchObject({
      id: "ticket-2",
      input: {
        title: "Updated",
        price: 2000,
        event: {
          startsAt: "2026-12-01T19:00:00Z",
          endsAt: "2026-12-01T21:30:00Z",
          imageUrl: "https://example.com/poster.png",
          venueName: "Updated Venue",
          venueAddress: "123 Main St",
        },
      },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-2");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-2");
  });

  it("replaceInactivePlan creates a replacement plan and re-links the ticket", async () => {
    executeMutationMock.mockResolvedValue({ createSeatingPlan: { id: "plan-new", status: "DRAFT", assignmentMode: "MANUAL" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: "plan-old",
          ticketId: "ticket-9",
          venueId: "11111111-1111-1111-1111-111111111111",
          name: "Main Floor",
          status: "inactive",
          assignmentMode: "manual",
          pricingMode: "section",
          maxSeatsPerOrder: 6,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await replaceInactivePlan(
      "ticket-9",
      "plan-old",
      "Concert",
      "35.00",
      "SEATED_MANUAL",
      {},
      new FormData()
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/seating-plans/plan-old");
    expect(executeMutationMock.mock.calls[0]?.[1]).toMatchObject({
      input: {
        ticketId: "ticket-9",
        venueId: "11111111-1111-1111-1111-111111111111",
        name: "Main Floor Replacement",
        assignmentMode: "MANUAL",
        maxSeatsPerOrder: 6,
        pricingMode: "section",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "35.00",
      seatingPlanId: "plan-new",
      ticketType: "SEATED_MANUAL",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-9");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-9/plans/plan-old");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-9/plans/plan-new");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-9/plans/plan-new");
  });
});
