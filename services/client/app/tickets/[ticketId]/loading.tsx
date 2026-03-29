// app/tickets/[ticketId]/loading.tsx — Suspense skeleton for ticket detail page.

export default function TicketDetailLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Back link skeleton */}
        <div className="mb-6 h-5 w-32 animate-pulse rounded bg-muted" />

        <div className="grid gap-6 md:grid-cols-3">
          {/* Info panel skeleton (2/3 width) */}
          <div className="md:col-span-2 space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            {/* Title */}
            <div className="h-7 w-3/4 animate-pulse rounded bg-muted" />
            {/* Badge */}
            <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
            {/* Metadata rows */}
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>

          {/* Action panel skeleton (1/3 width) */}
          <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      </div>
    </main>
  );
}
