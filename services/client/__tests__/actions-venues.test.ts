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

import { createVenue, createSeatingPlan, saveLayout } from "@/app/actions/venues";

function venueForm(name: string, capacity: string, timezone: string): FormData {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("capacity", capacity);
  fd.set("timezone", timezone);
  return fd;
}

function planForm(venueId: string, name: string): FormData {
  const fd = new FormData();
  fd.set("venueId", venueId);
  fd.set("name", name);
  return fd;
}

describe("venue server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
  });

  describe("createVenue", () => {
    it("should return error when name is blank", async () => {
      const result = await createVenue({}, venueForm("  ", "500", "America/New_York"));
      expect(result).toEqual({ error: "Venue name is required." });
    });

    it("should return error when capacity is zero", async () => {
      const result = await createVenue({}, venueForm("MSG", "0", "America/New_York"));
      expect(result).toEqual({ error: "Capacity must be a positive integer." });
    });

    it("should return error when timezone is blank", async () => {
      const result = await createVenue({}, venueForm("MSG", "500", "  "));
      expect(result).toEqual({ error: "Timezone is required." });
    });

    it("should return upstream error message on API failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          json: vi.fn().mockResolvedValue({ error: "internal error" }),
        })
      );
      const result = await createVenue({}, venueForm("MSG", "500", "America/New_York"));
      expect(result).toEqual({ error: "internal error" });
    });

    it("should revalidate /venues and redirect on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ id: "venue-1" }),
        })
      );
      await createVenue({}, venueForm("MSG", "500", "America/New_York"));
      expect(revalidatePathMock).toHaveBeenCalledWith("/venues");
      expect(redirectMock).toHaveBeenCalledWith("/venues/venue-1");
    });
  });

  describe("createSeatingPlan", () => {
    it("should return error when name is blank", async () => {
      const result = await createSeatingPlan({}, planForm("venue-1", "  "));
      expect(result).toEqual({ error: "Plan name is required." });
    });

    it("should return error when venueId is blank", async () => {
      const result = await createSeatingPlan({}, planForm("  ", "Main Floor"));
      expect(result).toEqual({ error: "Venue ID is required." });
    });

    it("should redirect to plan detail on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ id: "plan-1" }),
        })
      );
      await createSeatingPlan({}, planForm("venue-1", "Main Floor"));
      expect(revalidatePathMock).toHaveBeenCalledWith("/venues/venue-1");
      expect(redirectMock).toHaveBeenCalledWith("/venues/venue-1/plans/plan-1");
    });
  });

  describe("saveLayout", () => {
    it("should return error when planId is empty", async () => {
      const result = await saveLayout("", { nodes: [] });
      expect(result).toEqual({ error: "planId is required." });
    });

    it("should return error when layoutJson is not an object", async () => {
      const result = await saveLayout("plan-1", "not-an-object");
      expect(result).toEqual({ error: "layoutJson must be an object." });
    });

    it("should return upstream error message on API failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          json: vi.fn().mockResolvedValue({ error: "plan is not in draft" }),
        })
      );
      const result = await saveLayout("plan-1", { nodes: [] });
      expect(result).toEqual({ error: "plan is not in draft" });
    });

    it("should return empty object on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ id: "plan-1" }),
        })
      );
      const result = await saveLayout("plan-1", { nodes: [{ id: "sec-1", position: { x: 10, y: 20 }, data: {} }] });
      expect(result).toEqual({});
    });

    it("should call PATCH /api/seating-plans/:planId/layout with correct body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      const layoutJson = { nodes: [{ id: "sec-1", position: { x: 5, y: 10 }, data: { rowOffsets: { "0": 12 } } }] };
      await saveLayout("plan-42", layoutJson);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8080/api/seating-plans/plan-42/layout",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ layoutJson }),
        })
      );
    });
  });
});
