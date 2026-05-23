import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMutationMock = vi.fn();
const executeQueryMock = vi.fn();

vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

import { scanCheckIn, scanCheckInByEmail } from "@/app/actions/attendance";

describe("scanCheckIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid result when validateScan succeeds and recordCheckin succeeds", async () => {
    executeMutationMock
      .mockResolvedValueOnce({
        validateScan: {
          valid: true,
          reason: null,
          ticketId: "ticket-1",
          orderId: "order-1",
          eventId: "event-1",
        },
      })
      .mockResolvedValueOnce({
        recordCheckin: {
          id: "checkin-1",
          eventId: "event-1",
          ticketId: "ticket-1",
          orderId: "order-1",
          checkedInAt: "2026-05-22T10:00:00Z",
          source: "QR_SCAN",
        },
      });

    const result = await scanCheckIn({
      token: "qr-token",
      eventId: "event-1",
      deviceId: "device-1",
    });

    expect(result).toEqual({
      result: "valid",
      credentialId: "checkin-1",
      eventId: "event-1",
    });
    expect(executeMutationMock).toHaveBeenCalledTimes(2);
    expect(executeMutationMock.mock.calls[0]?.[1]).toEqual({ token: "qr-token" });
    expect(executeMutationMock.mock.calls[1]?.[1]).toEqual({
      input: { ticketId: "ticket-1", source: "QR_SCAN" },
    });
  });

  it("returns reason class when validateScan returns valid: false", async () => {
    executeMutationMock.mockResolvedValueOnce({
      validateScan: {
        valid: false,
        reason: "already_used",
        ticketId: null,
        orderId: null,
        eventId: "event-1",
      },
    });

    const result = await scanCheckIn({
      token: "used-token",
      eventId: "event-1",
      deviceId: "device-1",
    });

    expect(result).toEqual({ result: "already_used", eventId: "event-1" });
    expect(executeMutationMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_signature when validateScan reason is null", async () => {
    executeMutationMock.mockResolvedValueOnce({
      validateScan: {
        valid: false,
        reason: null,
        ticketId: null,
        orderId: null,
        eventId: null,
      },
    });

    const result = await scanCheckIn({
      token: "bad-token",
      eventId: "event-1",
      deviceId: "device-1",
    });

    expect(result).toEqual({ result: "invalid_signature", eventId: undefined });
  });

  it("throws when executeMutation (validateScan) rejects", async () => {
    executeMutationMock.mockRejectedValueOnce(new Error("GraphQL auth error"));

    await expect(
      scanCheckIn({ token: "qr-token", eventId: "event-1", deviceId: "device-1" })
    ).rejects.toThrow("GraphQL auth error");
  });
});

describe("scanCheckInByEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid result when user lookup succeeds and recordCheckinByUserId succeeds", async () => {
    executeQueryMock.mockResolvedValueOnce({
      userLookup: { id: "user-1", email: "buyer@example.com", displayName: null },
    });
    executeMutationMock.mockResolvedValueOnce({
      recordCheckinByUserId: {
        id: "checkin-2",
        eventId: "event-1",
        ticketId: "ticket-1",
        orderId: "order-1",
        checkedInAt: "2026-05-22T10:00:00Z",
        source: "USER_ID_LOOKUP",
      },
    });

    const result = await scanCheckInByEmail({
      eventId: "event-1",
      email: "buyer@example.com",
      deviceId: "device-1",
    });

    expect(result).toEqual({ result: "valid", eventId: "event-1" });
    expect(executeQueryMock.mock.calls[0]?.[1]).toEqual({ email: "buyer@example.com" });
    expect(executeMutationMock.mock.calls[0]?.[1]).toEqual({
      input: { eventId: "event-1", userId: "user-1" },
    });
  });

  it("throws when user lookup returns no result", async () => {
    executeQueryMock.mockResolvedValueOnce({ userLookup: null });

    await expect(
      scanCheckInByEmail({ eventId: "event-1", email: "nobody@example.com", deviceId: "d-1" })
    ).rejects.toThrow("Buyer account not found for the provided email.");
  });

  it("throws when executeQuery (userLookup) rejects", async () => {
    executeQueryMock.mockRejectedValueOnce(new Error("Auth service unavailable"));

    await expect(
      scanCheckInByEmail({ eventId: "event-1", email: "buyer@example.com", deviceId: "d-1" })
    ).rejects.toThrow("Auth service unavailable");
  });

  it("throws when executeMutation (recordCheckinByUserId) rejects", async () => {
    executeQueryMock.mockResolvedValueOnce({
      userLookup: { id: "user-1", email: "buyer@example.com", displayName: null },
    });
    executeMutationMock.mockRejectedValueOnce(new Error("Service unavailable"));

    await expect(
      scanCheckInByEmail({ eventId: "event-1", email: "buyer@example.com", deviceId: "d-1" })
    ).rejects.toThrow("Service unavailable");
  });
});
