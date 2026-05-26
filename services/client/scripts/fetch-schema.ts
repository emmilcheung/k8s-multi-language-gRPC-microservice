/**
 * Schema acquisition for client codegen.
 *
 * Phase 1 (this file): pulls the supergraph SDL from the on-disk
 * Apollo Router composition (`services/apollo-router/supergraph.graphql`)
 * and writes it to `.graphql-cache/supergraph.graphql`. The codegen step
 * reads from that cache so client code never depends on a path that
 * traverses outside the client package.
 *
 * Phase 1 follow-up: when the Apollo GraphOS registry is provisioned,
 * switch to `rover supergraph fetch ticketing-supergraph@current` here.
 * Local dev can opt out via `GRAPHQL_SCHEMA_LOCAL=1` to keep using the
 * on-disk file for fast iteration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, "..");
const cacheDir = resolve(clientRoot, ".graphql-cache");
const cachePath = resolve(cacheDir, "supergraph.graphql");
const localSupergraph = resolve(clientRoot, "..", "apollo-router", "supergraph.graphql");

function fail(message: string): never {
  console.error(`[fetch-schema] ${message}`);
  process.exit(1);
}

function fetchFromLocal(): string {
  if (!existsSync(localSupergraph)) {
    fail(
      `Local supergraph not found at ${localSupergraph}. ` +
        `Run "rover supergraph compose --config supergraph-config.yaml --output supergraph.graphql" in services/apollo-router/ first.`,
    );
  }
  return readFileSync(localSupergraph, "utf8");
}

function main(): void {
  // GRAPHQL_SCHEMA_REF is reserved for Phase 1 follow-up — the registry path.
  // Until that wiring lands, every environment uses the on-disk supergraph.
  // We log the source so build logs make the decision visible.
  const ref = process.env.GRAPHQL_SCHEMA_REF;
  if (ref) {
    fail(
      `GRAPHQL_SCHEMA_REF=${ref} requested but registry fetch is not yet wired. ` +
        `Unset the variable to fall back to the on-disk supergraph.`,
    );
  }

  // Cache hit: when the cache file is already present in the build context
  // (e.g. CI runs `pnpm codegen` on the runner before `docker build`, so the
  // populated `.graphql-cache/` is COPY'd into the image), trust it and skip
  // the monorepo-relative lookup — which would fail inside Docker because the
  // build context is scoped to `services/client/`.
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8");
    console.log(`[fetch-schema] cache hit at ${cachePath} (${cached.length} bytes); skipping fetch`);
    return;
  }

  const sdl = fetchFromLocal();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, sdl, "utf8");
  console.log(`[fetch-schema] wrote ${sdl.length} bytes from local supergraph -> ${cachePath}`);
}

main();
