// app/orders/[orderId]/loading.tsx — Suspense skeleton for order detail page.

export default function OrderDetailLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8">
        {/* Back link skeleton */}
        <div className="mb-6 h-5 w-32 animate-pulse rounded bg-muted" />

        {/* Header */}
        <div className="mb-6 space-y-2">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-5 w-64 animate-pulse rounded bg-muted" />
        </div>

        {/* Order card skeleton */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-5">
          {/* Status badge */}
          <div className="flex items-center justify-between">
            <div className="h-5 w-28 animate-pulse rounded-full bg-muted" />
            <div className="h-5 w-20 animate-pulse rounded bg-muted" />
          </div>

          {/* Ticket info rows */}
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between border-t pt-4">
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            </div>
          ))}

          {/* Action button */}
          <div className="pt-2">
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      </div>
    </main>
  );
}
