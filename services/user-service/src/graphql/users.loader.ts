import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";

/**
 * UserLoader — request-scoped DataLoader for User entity references.
 *
 * Apollo Router resolves N entity references by calling @ResolveReference once
 * per entity per request. Without batching this causes N round-trips.  This
 * loader coalesces all loads that arrive within the same event-loop tick into a
 * single batch, then fans the results back out in input order.
 *
 * Scoped to REQUEST so each GraphQL request gets its own loader instance
 * (avoiding cross-request data leaks and keeping the per-request cache safe).
 *
 * Because user-service holds no authoritative "users" table — identity lives in
 * auth-service — the batch function simply returns stub objects `{ id }` for
 * every key.  Downstream @ResolveField handlers (profile, preferences) perform
 * their own DB calls, which benefit from the deduplication guarantee that
 * DataLoader's per-request cache provides.
 */
@Injectable({ scope: Scope.REQUEST })
export class UserLoader {
  readonly loader: DataLoader<string, { id: string }>;

  constructor() {
    this.loader = new DataLoader<string, { id: string }>(
      (ids: readonly string[]) => {
        // No users table — return identity stubs preserving input order.
        // DataLoader requires the result array to be the same length and in the
        // same order as the keys array.
        return Promise.resolve(ids.map((id) => ({ id })));
      },
      {
        // Per-request cache: identical ids within the same request resolve once.
        cache: true,
        // Batch window — collect all loads from the same event-loop tick.
        batchScheduleFn: (callback) => process.nextTick(callback),
      },
    );
  }

  load(id: string): Promise<{ id: string }> {
    return this.loader.load(id);
  }
}
