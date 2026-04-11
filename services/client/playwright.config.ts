import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  workers: 2,  // minikube is resource-constrained; cap concurrency to avoid OOMKill
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev --port 4000",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "pk_test_mock",
      INTERNAL_API_URL: process.env.INTERNAL_API_URL ?? "http://localhost:8000",
      JWT_COOKIE_NAME: process.env.JWT_COOKIE_NAME ?? "token",
      REFRESH_COOKIE_NAME: process.env.REFRESH_COOKIE_NAME ?? "refreshToken",
      ACCESS_TOKEN_COOKIE_SAME_SITE:
        process.env.ACCESS_TOKEN_COOKIE_SAME_SITE ?? "strict",
      REFRESH_TOKEN_COOKIE_SAME_SITE:
        process.env.REFRESH_TOKEN_COOKIE_SAME_SITE ?? "strict",
      ACCESS_TOKEN_COOKIE_PATH: process.env.ACCESS_TOKEN_COOKIE_PATH ?? "/",
      REFRESH_COOKIE_PATH: process.env.REFRESH_COOKIE_PATH ?? "/",
      SESSION_REFRESH_SKEW_SECONDS:
        process.env.SESSION_REFRESH_SKEW_SECONDS ?? "30",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
