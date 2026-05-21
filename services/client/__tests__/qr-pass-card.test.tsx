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

  it("renders QR image with data-qr-token attribute for an issued pass", () => {
    render(
      <QRPassCard
        pass={{
          id: "cred-2",
          ticketId: "ticket-1",
          orderId: "order-1",
          eventId: "event-1",
          status: "ISSUED",
          issuedAt: "2026-01-01T00:00:00Z",
          qrToken: "qr-secret-token",
        }}
        qrDataUrl="data:image/png;base64,abc123"
      />
    );

    const img = screen.getByRole("img", { name: /admission qr code/i });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("data-qr-token", "qr-secret-token");
    expect(img).toHaveAttribute("src", "data:image/png;base64,abc123");
  });
});
