/**
 * The in-transaction audit writer (SLATE-302, ADR 010 §1).
 *
 * ADR 010 requires every admin mutation to leave exactly one attributable
 * `audit_log` row, written in the same transaction as the write so a failed
 * audit rolls the change back with it — the same guarantee SLATE-203's pipeline
 * gives (Sections 31, 61).
 */

import type { Transaction } from 'kysely';

import type { Database } from '@slate/database';

/** One audit row's inputs. Carries ids and small labels only — never secrets. */
export interface AuditInput {
  /** Tenant the action was performed in (the actor's resolved tenant). */
  readonly tenantId: string;
  /** The acting user; an audited admin action is always attributable to a person. */
  readonly actorUserId: string;
  /** Dotted action key, e.g. `admin.tenant.created`. */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Small, non-sensitive detail (ids, names) for the trail (Section 61). */
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Writes exactly one `audit_log` row inside the caller's transaction and returns
 * its id, so a mutation and its attribution commit together.
 */
export async function recordAudit(trx: Transaction<Database>, input: AuditInput): Promise<string> {
  const row = await trx
    .insertInto('audit_log')
    .values({
      tenant_id: input.tenantId,
      actor_user_id: input.actorUserId,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      payload: { ...(input.payload ?? {}) },
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
