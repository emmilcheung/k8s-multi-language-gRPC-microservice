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

import { createTicket, updateTicket } from "@/app/actions/tickets";

function ticketForm(title: string, price: string, startsAt = "2026-12-01T19:00:00Z"): FormData {
  const fd = new FormData();
  fd.set("title", title);
  fd.set("price", price);
  if (startsAt) fd.set("startsAt", startsAt);
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
      holdTtlSec: 300,
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
      holdTtlSec: 300,
      maxSeatsPerOrder: 10,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      title: "Concert",
      price: "12.50",
      seatingPlanId: "plan-2",
      ticketType: "SEATED_AUTO",
    });
  });

  it("updateTicket revalidates paths and redirects on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      })
    );

    await updateTicket("ticket-2", {}, ticketForm("Updated", "20"));

    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-2");
    expect(revalidatePathMock).toHaveBeenCalledWith("/");
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-2");
  });
});
