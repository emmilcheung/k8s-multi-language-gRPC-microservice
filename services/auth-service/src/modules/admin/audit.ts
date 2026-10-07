import { auditLog } from '../../database/schema';
import type { DrizzleDB } from '../../database/database.module';

export interface AuditEntry {
  actorUserId: string;
  actorAccountId?: string;
  action: string;
  resource: string;
  // Only the fields that changed.
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  traceId?: string;
}

// Anything with an insert() works, so callers pass their open transaction.
export type AuditTx = Pick<DrizzleDB, 'insert'>;

const REDACTED = '[redacted]';

// Audit history must outlive an attendee's right to be forgotten, so personal
// data is blanked at write time rather than trusted to each caller. Matching is
// by key: any email field, anything about an attendee, and person-name fields.
// A bare "name" is kept because it is an account, venue or event name.
const PERSON_NAME_KEYS = new Set([
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'holdername',
  'buyername',
  'guestname',
]);

function isPersonalKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    k.includes('email') || k.startsWith('attendee') || PERSON_NAME_KEYS.has(k)
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return redactPersonalData(value as Record<string, unknown>);
  }
  return value;
}

export function redactPersonalData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      isPersonalKey(key) ? REDACTED : redactValue(value),
    ]),
  );
}

// Writes inside the caller's transaction: the audit row and the change it
// describes commit or roll back together.
export async function record(tx: AuditTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    actorAccountId: entry.actorAccountId,
    action: entry.action,
    resource: entry.resource,
    before: entry.before && redactPersonalData(entry.before),
    after: entry.after && redactPersonalData(entry.after),
    reason: entry.reason,
    traceId: entry.traceId,
  });
}
