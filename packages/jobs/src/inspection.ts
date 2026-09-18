/**
 * Read-only job inspection (ADR 004).
 *
 * The API exposes summaries only — an explicit allowlist of lifecycle
 * metadata. Payloads, idempotency keys, lease tokens and raw error details are
 * never selected, let alone serialized. Cursors are opaque and only ever bound
 * the pagination window; they never influence which tenant is read.
 */

import type { Kysely } from 'kysely';

import { createTenantDatabase, type Database } from '@slate/database';

import { JobPayloadError } from './errors.ts';

/** Cursor input bounds (mirrors the API contract: limit 1–100, default 50). */
export const MIN_JOB_LIST_LIMIT = 1;
export const MAX_JOB_LIST_LIMIT = 100;
export const DEFAULT_JOB_LIST_LIMIT = 50;

/** The statuses the list endpoint may filter on. */
export const JOB_LIST_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type JobListStatus = (typeof JOB_LIST_STATUSES)[number];

/** The explicit response allowlist — metadata only, never payload internals. */
export interface JobSummary {
  readonly id: string;
  readonly type: string;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ListJobsInput {
  readonly tenantId: string;
  readonly limit?: number | undefined;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
}

export interface JobListPage {
  readonly jobs: readonly JobSummary[];
  /** Opaque cursor for the next page, or `null` at the end. */
  readonly nextCursor: string | null;
}

/** Validates the list limit against the API contract bounds. */
export function resolveJobListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_JOB_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < MIN_JOB_LIST_LIMIT || limit > MAX_JOB_LIST_LIMIT) {
    throw new JobPayloadError(
      `limit must be an integer in [${MIN_JOB_LIST_LIMIT}, ${MAX_JOB_LIST_LIMIT}].`,
    );
  }
  return limit;
}

/** Validates the optional status filter. */
export function resolveJobListStatus(status: string | undefined): JobListStatus | undefined {
  if (status === undefined) return undefined;
  if (!(JOB_LIST_STATUSES as readonly string[]).includes(status)) {
    throw new JobPayloadError(`status must be one of: ${JOB_LIST_STATUSES.join(', ')}.`);
  }
  return status as JobListStatus;
}

/** Encodes an opaque `(created_at, id)` continuation cursor. */
export function encodeJobCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor; invalid input is a 400, never a scope change. */
export function decodeJobCursor(cursor: string): { createdAt: Date; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new JobPayloadError('cursor is not a valid base64url token.');
  }
  const separator = decoded.indexOf('|');
  const createdAtText = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const createdAt = new Date(createdAtText);
  if (
    separator < 0 ||
    createdAtText === '' ||
    id === '' ||
    Number.isNaN(createdAt.getTime()) ||
    !/^[0-9a-f-]{36}$/i.test(id)
  ) {
    throw new JobPayloadError('cursor is not a valid continuation token.');
  }
  return { createdAt, id };
}

/** The columns both read paths select — the summary allowlist, nothing more. */
const SUMMARY_COLUMNS = [
  'id',
  'type',
  'status',
  'attempts',
  'max_attempts',
  'available_at',
  'created_at',
  'updated_at',
  'finished_at',
  'last_error_code',
] as const;

/** Maps a stored row to the response allowlist (ISO timestamps). */
function toSummary(row: {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  max_attempts: number;
  available_at: Date;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  last_error_code: string | null;
}): JobSummary {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
    lastErrorCode: row.last_error_code,
  };
}

/** Lists one tenant's jobs, ascending by `(created_at, id)`, cursor-paginated. */
export async function listJobs(db: Kysely<Database>, input: ListJobsInput): Promise<JobListPage> {
  const limit = resolveJobListLimit(input.limit);
  const status = resolveJobListStatus(input.status);
  const cursor = input.cursor === undefined ? undefined : decodeJobCursor(input.cursor);
  let builder = createTenantDatabase(db, input.tenantId)
    .selectFrom('background_job')
    .select([...SUMMARY_COLUMNS])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc');
  if (status !== undefined) builder = builder.where('status', '=', status);
  if (cursor !== undefined) {
    builder = builder.where((expression) =>
      expression.or([
        expression('created_at', '>', cursor.createdAt),
        expression.and([
          expression('created_at', '=', cursor.createdAt),
          expression('id', '>', cursor.id),
        ]),
      ]),
    );
  }
  const rows = await builder.limit(limit + 1).execute();
  const page = rows.slice(0, limit).map(toSummary);
  const last = page[page.length - 1];
  return {
    jobs: page,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeJobCursor(new Date(last.createdAt), last.id)
        : null,
  };
}

/** One tenant's job by id, or `null` (a foreign id is the same null). */
export async function getJob(
  db: Kysely<Database>,
  input: { readonly tenantId: string; readonly jobId: string },
): Promise<JobSummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(input.jobId)) {
    throw new JobPayloadError('job id is not a UUID.');
  }
  const row = await createTenantDatabase(db, input.tenantId)
    .selectFrom('background_job')
    .select([...SUMMARY_COLUMNS])
    .where('id', '=', input.jobId)
    .executeTakeFirst();
  return row === undefined ? null : toSummary(row);
}
