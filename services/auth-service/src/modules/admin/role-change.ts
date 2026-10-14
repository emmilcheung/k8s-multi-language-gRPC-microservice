import { eq } from 'drizzle-orm';
import { trace } from '@opentelemetry/api';
import type { DrizzleDB } from '../../database/database.module';
import { users } from '../../database/schema';
import { record } from './audit';
import type { PlatformRole } from './platform-roles';

export type RoleAction = 'grant' | 'remove';

export interface RoleChange {
  /** Who made the change: a user id, or `cli:<os user>` for the operator CLI. */
  actorUserId: string;
  targetUserId: string;
  role: PlatformRole;
  action: RoleAction;
  reason: string;
}

export interface RoleChangeResult {
  userId: string;
  roles: string[];
  /** False when the user already had (or already lacked) the role. */
  changed: boolean;
}

/** Thrown when the target user does not exist. */
export class RoleTargetNotFoundError extends Error {}

/**
 * Change one platform role and write its audit row in one transaction. The user
 * row is locked first so two concurrent changes cannot overwrite each other's
 * roles. A change that alters nothing writes no audit row.
 */
export async function applyRoleChange(
  db: DrizzleDB,
  change: RoleChange,
): Promise<RoleChangeResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: users.id, roles: users.roles })
      .from(users)
      .where(eq(users.id, change.targetUserId))
      .for('update');
    if (!row) throw new RoleTargetNotFoundError(change.targetUserId);

    const before = row.roles;
    const has = before.includes(change.role);
    const after =
      change.action === 'grant'
        ? has
          ? before
          : [...before, change.role]
        : before.filter((r) => r !== change.role);
    const changed = after.length !== before.length;
    if (!changed) return { userId: row.id, roles: before, changed };

    await tx
      .update(users)
      .set({ roles: after, updatedAt: new Date() })
      .where(eq(users.id, row.id));
    await record(tx, {
      actorUserId: change.actorUserId,
      action: `platform_role.${change.action}`,
      resource: `user:${row.id}`,
      before: { roles: before },
      after: { roles: after },
      reason: change.reason,
      traceId: trace.getActiveSpan()?.spanContext().traceId,
    });
    return { userId: row.id, roles: after, changed };
  });
}
