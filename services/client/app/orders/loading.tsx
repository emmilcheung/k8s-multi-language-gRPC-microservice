// app/orders/loading.tsx — Suspense skeleton for the My Orders list page.

export default function OrdersLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-8">
        {/* Page header */}
        <div className="mb-8 space-y-2">
          <div className="h-8 w-40 animate-pulse rounded bg-muted" />
          <div className="h-5 w-56 animate-pulse rounded bg-muted" />
        </div>

        {/* Order card skeletons */}
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-xl border-l-4 border-muted bg-card p-5 shadow-sm"
            >
              <div className="space-y-2 flex-1">
                <div className="h-5 w-48 animate-pulse rounded bg-muted" />
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
              <div className="ml-4 flex items-center gap-3">
                <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
                <div className="h-5 w-5 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
