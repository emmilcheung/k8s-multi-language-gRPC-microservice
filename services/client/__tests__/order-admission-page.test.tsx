import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const cookieStoreMock = { get: vi.fn(), toString: vi.fn(() => "token=test") };
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(cookieStoreMock),
}));

const orderQueryMock = vi.fn();
vi.mock("@/lib/graphql-client", () => ({
  createGraphQLClient: () => ({
    query: () => ({
      toPromise: orderQueryMock,
    }),
  }),
}));

const serverApiMock = vi.fn();
vi.mock("@/lib/api", () => ({
  serverApi: (...args: unknown[]) => serverApiMock(...args as Parameters<typeof serverApiMock>),
}));

describe("Order admission entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStoreMock.get.mockReturnValue({ value: "token" });
    serverApiMock.mockResolvedValue({ paymentMethods: [] });
  });

  it("shows admission pass link for completed orders", async () => {
    orderQueryMock.mockResolvedValue({
      data: {
        order: {
          id: "order-1",
          userId: "buyer-1",
          status: "COMPLETE",
          quantity: 1,
          expiresAt: "2026-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          ticket: { id: "ticket-1", title: "Show", price: "10.00" },
        },
      },
    });

    const { default: OrderDetailPage } = await import("@/app/orders/[orderId]/page");
    render(await OrderDetailPage({ params: Promise.resolve({ orderId: "order-1" }) }));

    expect(screen.getByRole("link", { name: /open admission pass/i })).toHaveAttribute(
      "href",
      "/tickets/ticket-1/admission?orderId=order-1"
    );
  });

  it("does not show admission pass link for non-complete orders", async () => {
    orderQueryMock.mockResolvedValue({
      data: {
        order: {
          id: "order-2",
          userId: "buyer-1",
          status: "CANCELLED",
          quantity: 1,
          expiresAt: "2026-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          ticket: { id: "ticket-1", title: "Show", price: "10.00" },
        },
      },
    });

    const { default: OrderDetailPage } = await import("@/app/orders/[orderId]/page");
    render(await OrderDetailPage({ params: Promise.resolve({ orderId: "order-2" }) }));

    expect(screen.queryByRole("link", { name: /open admission pass/i })).not.toBeInTheDocument();
  });
});
