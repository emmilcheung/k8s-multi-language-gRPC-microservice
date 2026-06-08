import type { ReactNode } from "react";

interface AuthShellProps {
  children: ReactNode;
}

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid min-h-[calc(100vh-9rem)] overflow-hidden rounded-3xl border border-line bg-card lg:grid-cols-[minmax(0,1fr)_540px]">
        <section className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:bg-[linear-gradient(160deg,oklch(0.97_0.015_260)_0%,oklch(0.92_0.04_270)_60%,oklch(0.95_0.06_30)_100%)] lg:px-14 lg:py-12 lg:text-ink">
          <div className="absolute inset-0 bg-[radial-gradient(60%_80%_at_30%_30%,rgba(255,140,80,0.25),transparent_60%),radial-gradient(80%_90%_at_90%_100%,rgba(80,140,255,0.18),transparent_60%)] opacity-80" />

          <div className="relative flex flex-col gap-10">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-mute">
              The ticketing platform
            </span>

            <div className="max-w-md space-y-5">
              <h2 className="text-5xl font-semibold tracking-[-0.03em] text-ink">
                Buy the ticket.
                <br />
                Take the ride.
              </h2>
              <p className="text-sm leading-6 text-mute">
                Discover live music, sports, comedy, and theatre near you with mobile passes,
                effortless transfers, and refund protection on every order.
              </p>
            </div>
          </div>

          <div className="relative space-y-3">
            {[
              "No hidden fees before checkout",
              "Refund protection on every order",
              "One-tap transfers when they launch",
            ].map((benefit) => (
              <div key={benefit} className="flex items-center gap-3 text-sm text-mute">
                <span className="inline-flex size-5 items-center justify-center rounded-full border border-line text-xs">
                  *
                </span>
                <span>{benefit}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
          {children}
        </section>
      </div>
    </div>
  );
}
