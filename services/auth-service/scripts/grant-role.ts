/**
 * Operator bootstrap: pnpm admin:grant-role <email> <role>
 *
 * Talks to the database only (DATABASE_URL). No HTTP, no env-var bootstrap, no
 * self-service: this is the only way to create the first platform admin.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/database/schema';
import { grantRoleByEmail } from '../src/modules/admin/grant-role.cli';

async function main(): Promise<void> {
  const [email, role] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!email || !role || process.argv.length !== 4) {
    console.error('usage: pnpm admin:grant-role <email> <role>');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await grantRoleByEmail(
      drizzle(pool, { schema }),
      email,
      role,
    );
    console.log(
      result.changed
        ? `Granted ${role} to ${email}; roles are now ${JSON.stringify(result.roles)}`
        : `${email} already has ${role}; nothing changed`,
    );
    console.log(
      'The role appears in tokens issued from the next sign-in or refresh.',
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
