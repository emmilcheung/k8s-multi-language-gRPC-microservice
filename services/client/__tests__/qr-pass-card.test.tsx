import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QRPassCard } from "@/components/qr-pass-card";

describe("QRPassCard", () => {
  it("renders the wallet-style issued state with the live QR payload", () => {
    render(
      <QRPassCard
        pass={{
          id: "cred-1",
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

    expect(screen.getByText(/valid for entry/i)).toBeInTheDocument();
    expect(screen.getByText(/show this code at the gate/i)).toBeInTheDocument();

    const img = screen.getByRole("img", { name: /admission qr code/i });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/png;base64,abc123");
    expect(img).toHaveAttribute("data-qr-token", "qr-secret-token");
  });

  it("shows the used stamp state when the credential has already been scanned", () => {
    render(
      <QRPassCard
        pass={{
          id: "cred-2",
          ticketId: "ticket-1",
          orderId: "order-1",
          eventId: "event-1",
          status: "USED",
          issuedAt: "2026-01-01T00:00:00Z",
          usedAt: "2026-01-01T20:42:00Z",
          qrToken: "used-secret-token",
        }}
        qrDataUrl="data:image/png;base64,abc123"
      />
    );

    expect(screen.getByText("USED")).toBeInTheDocument();
    expect(screen.getByText(/scanned/i)).toBeInTheDocument();
  });

  it("shows the revoked state as no longer valid for entry", () => {
    render(
      <QRPassCard
        pass={{
          id: "cred-3",
          ticketId: "ticket-1",
          orderId: "order-1",
          eventId: "event-1",
          status: "REVOKED",
          issuedAt: "2026-01-01T00:00:00Z",
          qrToken: "token",
        }}
      />
    );

    expect(screen.getAllByText("REVOKED")).toHaveLength(2);
    expect(screen.getByText(/this pass is no longer valid/i)).toBeInTheDocument();
  });
});
