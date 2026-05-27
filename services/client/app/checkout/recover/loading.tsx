import { Skeleton } from "@/components/ui/skeleton";

export default function CheckoutRecoverLoading() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 py-8">
      <div className="rounded-md border border-line bg-card p-6">
        <div className="flex items-center gap-4 border-b border-line pb-5">
          <Skeleton className="size-11 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-64" />
          </div>
        </div>
        <div className="space-y-4 pt-6">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <div className="space-y-3 rounded-md border border-line bg-subtle p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
      </div>
      <Skeleton className="h-16 w-full rounded-md" />
    </div>
  );
}
