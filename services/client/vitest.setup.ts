// vitest.setup.ts — Global test setup: extends expect with jest-dom matchers.
import "@testing-library/jest-dom";
import { vi } from "vitest";

// next/navigation has no Router context in jsdom.
// Provide no-op stubs so components that call useRouter / usePathname etc.
// can be unit-tested without a full Next.js render environment.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
