/**
 * Feature-flag override control panel (SLATE-302, ADR 010 §4).
 *
 * The panel reads the effective value and its source through `@slate/settings`
 * (`override → registry default → false`); it invents no storage and no rule of
 * its own. A write may only address a declared flag, runs in a transaction and
 * leaves exactly one audit row.
 */

import type { Kysely } from 'kysely';

import type { Database } from '@slate/database';
import {
  createTenantConfiguration,
  FEATURE_FLAG_KEYS,
  type FeatureFlagSource,
} from '@slate/settings';

import { recordAudit } from './audit.ts';
import { ADMIN_PERMISSIONS, requirePermission, type AdminActor } from './permissions.ts';

/** One row of the flag control panel. */
export interface FlagPanelEntry {
  readonly key: string;
  readonly enabled: boolean;
  /** Which rule produced `enabled` — shown so the reason is visible. */
  readonly source: FeatureFlagSource;
}

/** Raised when a flag write input is invalid. */
export class FlagInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'FlagInputError';
  }
}

/** `true`/`false` set an override, `null` clears it back to the default. */
function parseEnabled(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 'on') return true;
  if (value === false || value === 'false' || value === 'off') return false;
  if (value === null || value === undefined || value === '' || value === 'default') return null;
  throw new FlagInputError('A flag value must be true, false, or default.');
}

/** The feature-flag admin surface. */
export interface FlagAdminService {
  panel(actor: AdminActor): Promise<readonly FlagPanelEntry[]>;
  setOverride(
    actor: AdminActor,
    input: { readonly key: unknown; readonly enabled: unknown },
  ): Promise<FlagPanelEntry>;
}

/** Wires the flag admin service to a database client. */
export function createFlagAdminService(db: Kysely<Database>): FlagAdminService {
  return {
    async panel(actor) {
      requirePermission(actor, ADMIN_PERMISSIONS.flagRead);
      const flags = createTenantConfiguration(db).flags;
      return Promise.all(
        FEATURE_FLAG_KEYS.map(async (key) =>
          flags.resolveFeatureFlag({ tenantId: actor.tenantId, key }),
        ),
      );
    },

    async setOverride(actor, input) {
      requirePermission(actor, ADMIN_PERMISSIONS.flagManage);
      const key = typeof input.key === 'string' ? input.key.trim() : '';
      if (key === '') throw new FlagInputError('A flag key is required.');
      const enabled = parseEnabled(input.enabled);

      return db.transaction().execute(async (trx) => {
        const resolved = await createTenantConfiguration(trx).flags.setFeatureFlag({
          tenantId: actor.tenantId,
          key,
          enabled,
        });
        await recordAudit(trx, {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'admin.feature-flag.changed',
          resourceType: 'feature_flag',
          resourceId: resolved.key,
          payload: { key: resolved.key, requested: enabled, enabled: resolved.enabled },
        });
        return { key: resolved.key, enabled: resolved.enabled, source: resolved.source };
      });
    },
  };
}
