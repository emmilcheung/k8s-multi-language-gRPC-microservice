import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QRPassCard } from "@/components/qr-pass-card";

describe("QRPassCard", () => {
  it("shows non-admittable state for revoked pass", () => {
    render(
      <QRPassCard
        pass={{
          id: "cred-1",
          ticketId: "ticket-1",
          orderId: "order-1",
          eventId: "event-1",
          status: "REVOKED",
          issuedAt: "2026-01-01T00:00:00Z",
          qrToken: "token",
        }}
      />
    );

    expect(screen.getByText(/no longer valid for entry/i)).toBeInTheDocument();
  });
});
