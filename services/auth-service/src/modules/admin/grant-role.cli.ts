import { userInfo } from 'os';
import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../../database/database.module';
import { users } from '../../database/schema';
import { PLATFORM_ROLES, type PlatformRole } from './platform-roles';
import { applyRoleChange, type RoleChangeResult } from './role-change';

export const CLI_BOOTSTRAP_REASON = 'bootstrap via admin:grant-role';

/** Audit actor for the operator CLI: `cli:<os user>`, never a real user id. */
export function cliActor(osUser: string = userInfo().username): string {
  return `cli:${osUser}`;
}

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * Database-only bootstrap: grants a platform role to the user with this email
 * and writes the audit row. It is the only way to create the first admin.
 * Takes effect at the user's next token issue.
 */
export async function grantRoleByEmail(
  db: DrizzleDB,
  email: string,
  role: string,
  actor: string = cliActor(),
): Promise<RoleChangeResult> {
  if (!isPlatformRole(role)) {
    throw new Error(
      `Unknown role "${role}"; expected one of: ${PLATFORM_ROLES.join(', ')}`,
    );
  }
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) throw new Error(`No user with email ${email}`);
  return applyRoleChange(db, {
    actorUserId: actor,
    targetUserId: user.id,
    role,
    action: 'grant',
    reason: CLI_BOOTSTRAP_REASON,
  });
}
