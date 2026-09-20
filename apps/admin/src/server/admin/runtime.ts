/**
 * The admin services, wired to the app's platform runtime (SLATE-302).
 *
 * Mirrors the app's other server zone: the database is built lazily from the
 * environment, so a missing configuration is a runtime failure rather than a
 * build failure. Screens and server actions reach services only through here.
 */

import type { Kysely } from 'kysely';

import type { Database } from '@slate/database';

import { platformRuntime } from '../platform.ts';
import { createFlagAdminService, type FlagAdminService } from './flags.ts';
import { createTenantAdminService, type TenantAdminService } from './tenants.ts';
import { createUserAdminService, type UserAdminService } from './users.ts';

/** The wired admin surface the pages and server actions share. */
export interface AdminServices {
  readonly db: Kysely<Database>;
  readonly tenants: TenantAdminService;
  readonly users: UserAdminService;
  readonly flags: FlagAdminService;
}

/** Raised when the platform runtime is not configured (missing environment). */
export class AdminRuntimeError extends Error {
  readonly status = 503;

  constructor() {
    super('The platform runtime is not configured; set DATABASE_URL and SESSION_SECRET.');
    this.name = 'AdminRuntimeError';
  }
}

/** Builds the admin services against the mounted platform's database. */
export async function adminServices(): Promise<AdminServices> {
  const runtime = await platformRuntime();
  if (runtime === undefined) throw new AdminRuntimeError();
  const { db } = runtime;
  return {
    db,
    tenants: createTenantAdminService(db),
    users: createUserAdminService(db),
    flags: createFlagAdminService(db),
  };
}
