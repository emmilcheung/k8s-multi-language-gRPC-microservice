// app/orders/[orderId]/loading.tsx — Suspense skeleton for order detail page.

import { Skeleton } from "@/components/ui/skeleton";

export default function OrderDetailLoading() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-2">
      <Skeleton className="h-8 w-28" />

      <div className="rounded-md border border-line bg-card px-8 py-5">
        <div className="flex items-center gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-3 w-20" />
              </div>
              {i < 2 && <Skeleton className="h-px flex-1 mx-3 mb-5" />}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded-md border border-line bg-card p-8 flex flex-col gap-6">
          <Skeleton className="h-6 w-36" />
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 rounded-xl" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-5 w-40" />
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 rounded-xl" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
          </div>
          <Skeleton className="h-px w-full" />
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>

        <div className="rounded-md border border-line bg-card p-6 flex flex-col gap-4">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
