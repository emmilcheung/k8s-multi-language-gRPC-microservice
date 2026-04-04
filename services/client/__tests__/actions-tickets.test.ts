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
    expect(redirectMock).toHaveBeenCalledWith("/tickets/ticket-1");
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
