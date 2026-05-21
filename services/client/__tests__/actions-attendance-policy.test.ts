import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const executeMutationMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

import { updateAttendancePolicyAction } from "@/app/actions/attendance-policy";

describe("attendance policy server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates attendance policy via GraphQL and revalidates the attendance page", async () => {
    executeMutationMock.mockResolvedValueOnce({
      updateAttendancePolicy: {
        eventId: "ticket-1",
        requireQrForEntry: false,
        allowManualOverride: true,
      },
    });

    const result = await updateAttendancePolicyAction("ticket-1", {
      requireQrForEntry: false,
      allowManualOverride: true,
    });

    expect(executeMutationMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        eventId: "ticket-1",
        input: {
          requireQrForEntry: false,
          allowManualOverride: true,
        },
      },
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/tickets/ticket-1/attendance");
    expect(result).toEqual({
      policy: {
        eventId: "ticket-1",
        requireQrForEntry: false,
        allowManualOverride: true,
      },
    });
  });

  it("returns a friendly error when the mutation fails", async () => {
    executeMutationMock.mockRejectedValueOnce(new Error("boom"));

    const result = await updateAttendancePolicyAction("ticket-1", {
      requireQrForEntry: true,
      allowManualOverride: false,
    });

    expect(result).toEqual({ error: "boom" });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
