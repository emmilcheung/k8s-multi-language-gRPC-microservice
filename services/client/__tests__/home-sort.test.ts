import { shouldClientSort } from "@/app/page";
import { describe, test, expect } from "vitest";

describe("shouldClientSort", () => {
  test("preserve relevance when q present and no explicit sort", () => {
    expect(shouldClientSort("swift", undefined)).toBe(false);
  });

  test("honor explicit sort even with q (rule B)", () => {
    expect(shouldClientSort("swift", "date")).toBe(true);
    expect(shouldClientSort("swift", "price")).toBe(true);
  });

  test("browse (no q) always client-sorts", () => {
    expect(shouldClientSort("", undefined)).toBe(true);
  });
});
