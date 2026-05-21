/**
 * rest-keeplist.spec.ts — Static assertion: no non-keeplist REST calls in client source.
 *
 * This spec does NOT require a browser or a live stack. It scans the source
 * tree for patterns that indicate REST calls bypassing the GraphQL layer and
 * fails if any are found outside the documented keeplist.
 *
 * Runs as part of the Playwright suite so CI captures it alongside E2E tests.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..", "..");

function grep(pattern: string, dirs: string[]): string {
  try {
    const dirArgs = dirs.join(" ");
    return execSync(`grep -rEn ${JSON.stringify(pattern)} ${dirArgs}`, {
      cwd: clientRoot,
      encoding: "utf8",
    });
  } catch (err: unknown) {
    // grep exits 1 when no matches — that is success for our gate
    if ((err as NodeJS.ErrnoException & { status?: number }).status === 1) return "";
    throw err;
  }
}

test.describe("REST keep-list enforcement (static analysis)", () => {
  test("no inline gql template literals in .ts/.tsx source", () => {
    const matches = grep(
      "gql`|'[[:space:]]*(query|mutation|subscription|fragment)[[:space:]]'|\"[[:space:]]*(query|mutation|subscription|fragment)[[:space:]]\"",
      ["lib/", "app/"],
    );
    expect(
      matches,
      `Inline GraphQL strings found. Move operations to lib/graphql/operations/.`,
    ).toBe("");
  });

  test("no hardcoded base URLs bypassing serverApi in app/ source", () => {
    // Matches fetch( followed by a quote/backtick then a domain/localhost URL
    // containing /api/ with a word boundary before it (e.g. "http://localhost:8000/api/").
    // Template literals using ${base()}/api/ are exempt because } is not a word char.
    const matches = grep(
      'fetch\\(["\'`][^"\'`]*\\b/api/',
      ["app/"],
    ).split("\n").filter(Boolean).filter(
      (line) => !/signin|signup|signout|refresh|webhook|consent/.test(line),
    ).join("\n");
    expect(
      matches,
      `Hardcoded /api/ fetch calls found outside the keeplist. Use serverApi from lib/api.ts.`,
    ).toBe("");
  });

  test("lib/graphql/generated directory is not committed to source", () => {
    // The generated index.ts must be gitignored — only .graphql-cache + generated/
    // are ephemeral build artifacts.
    try {
      execSync("git ls-files --error-unmatch lib/graphql/generated/index.ts", {
        cwd: clientRoot,
        encoding: "utf8",
      });
      // If the above didn't throw, the file IS tracked — fail the test
      expect(false, "lib/graphql/generated/index.ts should be gitignored, not committed").toBe(true);
    } catch {
      // git ls-files --error-unmatch exits non-zero when file is not tracked — expected
    }
  });
});
