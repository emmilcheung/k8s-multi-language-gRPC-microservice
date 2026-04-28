import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const redirectMock = vi.fn();
const authHeadersMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
  authHeaders: () => authHeadersMock(),
}));

import { createTicket, fetchTicketPage, replaceInactivePlan, updateTicket } from "@/app/actions/tickets";

function ticketForm(title: string, price: string, startsAt = "2026-12-01T19:00:00Z"): FormData {
  const fd = new FormData();
  fd.set("title", title);
  fd.set("price", price);
  if (startsAt) fd.set("startsAt", startsAt);
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
  });

  it("createTicket validates title", async () => {
    const result = await createTicket({}, ticketForm("  ", "10"));
    expect(result).toEqual({ error: "Title is required." });
  });

  it("createTicket validates positive price", async () => {
    const result = await createTicket({}, ticketForm("Show", "0"));
    expect(result).toEqual({ error: "Price must be a positive number." });
  });

  it("createTicket returns upstream error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: { message: "Validation failed" } }),
      })
    );

    const result = await createTicket({}, ticketForm("Concert", "12.50"));
    expect(result).toEqual({ error: "Validation failed" });
  });

  it("createTicket redirects to created ticket on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "ticket-1" }),
      })
    );

    await createTicket({}, ticketForm("Concert", "12.50"));

    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links a seating plan for seated tickets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "ticket-1", title: "Concert", price: "12.50" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "plan-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/tickets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:8080/api/seating-plans");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:8080/api/tickets/ticket-1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Concert",
      price: "12.50",
      quota: 0,
      event: { startsAt: "2026-12-01T19:00:00Z" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ticketId: "ticket-1",
      venueId: "11111111-1111-1111-1111-111111111111",
      name: "Concert Seating Plan",
      assignmentMode: "manual",
      maxSeatsPerOrder: 10,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-1",
      ticketType: "SEATED_MANUAL",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links a manual seating plan for seated tickets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "ticket-1", title: "Concert", price: "12.50" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "plan-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket({}, seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/tickets");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:8080/api/seating-plans");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:8080/api/tickets/ticket-1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Concert",
      price: "12.50",
      quota: 0,
      event: { startsAt: "2026-12-01T19:00:00Z" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ticketId: "ticket-1",
      venueId: "11111111-1111-1111-1111-111111111111",
      name: "Concert Seating Plan",
      assignmentMode: "manual",
      maxSeatsPerOrder: 10,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-1",
      ticketType: "SEATED_MANUAL",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
  });

  it("createTicket creates and links an auto-assigned seating plan for seated tickets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "ticket-2", title: "Concert", price: "12.50" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "plan-2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    await createTicket(
      {},
      seatedTicketForm("Concert", "12.50", "11111111-1111-1111-1111-111111111111", "SEATED_AUTO")
    );

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ticketId: "ticket-2",
      venueId: "11111111-1111-1111-1111-111111111111",
      name: "Concert Seating Plan",
      assignmentMode: "auto",
      maxSeatsPerOrder: 10,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-2",
      ticketType: "SEATED_AUTO",
    });
  });

  it("fetchTicketPage excludes seated tickets whose plans are not active", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            id: "ga-1",
            title: "GA Ticket",
            price: "25.00",
            createdAt: "2026-12-01T19:00:00Z",
          },
          {
            id: "seated-draft",
            title: "Draft Seated",
            price: "55.00",
            seatingPlanId: "plan-draft",
            createdAt: "2026-12-01T18:00:00Z",
          },
          {
            id: "seated-active",
            title: "Active Seated",
            price: "65.00",
            seatingPlanId: "plan-active",
            createdAt: "2026-12-01T17:00:00Z",
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "draft" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ counts: { available: 50 } }),
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

    const page = await fetchTicketPage(null);

    expect(page.tickets.map((ticket) => ticket.id)).toEqual(["ga-1", "seated-active"]);
  });

  it("fetchTicketPage excludes seated tickets with no available seats", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            id: "seated-sold-out",
            title: "Sold Out Seated",
            price: "65.00",
            seatingPlanId: "plan-sold-out",
            createdAt: "2026-12-01T17:00:00Z",
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "active" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ counts: { available: 0 } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchTicketPage(null);

    expect(page.tickets).toEqual([]);
  });

  it("updateTicket sends event metadata, revalidates paths, and redirects on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateTicket("ticket-2", {}, ticketUpdateForm("Updated", "20"));

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      title: "Updated",
      price: "20",
      event: {
        title: "Updated Event",
        description: "Updated description",
        startsAt: "2026-12-01T19:00:00Z",
        endsAt: "2026-12-01T21:30:00Z",
        imageUrl: "https://example.com/poster.png",
        venueName: "Updated Venue",
        venueAddress: "123 Main St",
      },
    });

    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-2");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-2");
  });

  it("replaceInactivePlan creates a replacement plan and re-links the ticket", async () => {
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
        json: vi.fn().mockResolvedValue({ id: "plan-new" }),
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/seating-plans/plan-old");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      ticketId: "ticket-9",
      venueId: "11111111-1111-1111-1111-111111111111",
      name: "Main Floor Replacement",
      assignmentMode: "manual",
      maxSeatsPerOrder: 6,
      pricingMode: "section",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
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
