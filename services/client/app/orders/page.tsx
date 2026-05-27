import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OrdersPageDocument, TicketDetailDocument, SavedEventsDocument } from "@/lib/graphql/generated";
import { executeQuery } from "@/lib/graphql/execute";
import { coerceOrderStatus } from "@/lib/order-status";
import { OrdersOverview, type OrdersOverviewOrder, type SavedEventItem } from "@/components/orders/orders-overview";

export const metadata = { title: "My Orders — Marquee" };

async function getOrders(cookieHeader: string): Promise<OrdersOverviewOrder[]> {
  try {
    const data = await executeQuery(OrdersPageDocument, {}, { cookie: cookieHeader });
    const ticketIds = [...new Set(data.orders.map((order) => order.ticket.id))];
    const ticketDetails = new Map(
      await Promise.all(
        ticketIds.map(async (ticketId) => {
          try {
            const detail = await executeQuery(TicketDetailDocument, { id: ticketId }, { cookie: cookieHeader });
            return [ticketId, detail.ticket ?? null] as const;
          } catch {
            return [ticketId, null] as const;
          }
        })
      )
    );

    return data.orders.map((order): OrdersOverviewOrder => {
      const ticketDetail = ticketDetails.get(order.ticket.id);
      return {
        id: order.id,
        userId: order.userId,
        status: coerceOrderStatus(order.status),
        quantity: order.quantity,
        expiresAt: order.expiresAt ?? "",
        ticket: {
          id: order.ticket.id,
          title: order.ticket.title,
          price: order.ticket.price,
        },
        event: ticketDetail?.event
          ? {
              title: ticketDetail.event.title,
              startsAt: ticketDetail.event.startsAt,
              venueName: ticketDetail.event.venueName ?? undefined,
              venueAddress: ticketDetail.event.venueAddress ?? undefined,
            }
          : undefined,
        seatingPlanId: ticketDetail?.seatingPlan?.id ?? null,
        version: 0,
      };
    });
  } catch {
    return [];
  }
}

async function getSavedEvents(cookieHeader: string): Promise<SavedEventItem[]> {
  try {
    const data = await executeQuery(SavedEventsDocument, { first: 50 }, { cookie: cookieHeader });
    return data.savedEvents.edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.event?.title || edge.node.title,
      priceDecimal: edge.node.priceDecimal,
      startsAt: edge.node.event?.startsAt,
      imageUrl: edge.node.event?.imageUrl ?? undefined,
      venueName: edge.node.event?.venueName ?? undefined,
      venueAddress: edge.node.event?.venueAddress ?? undefined,
    }));
  } catch {
    return [];
  }
}

export default async function OrdersPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("token")?.value) {
    redirect("/auth/signin");
  }

  const cookieHeader = cookieStore.toString();
  const [orders, savedEvents] = await Promise.all([
    getOrders(cookieHeader),
    getSavedEvents(cookieHeader),
  ]);

  return <OrdersOverview orders={orders} savedEvents={savedEvents} />;
}
