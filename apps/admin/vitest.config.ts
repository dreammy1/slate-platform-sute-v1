import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * Unit suite for the admin feature modules (SLATE-302): the pure permission
 * guard and the sanitized health projection, both Node-only.
 *
 * Vitest is invoked from the package directory (the npm workspace script runs
 * with `cwd = apps/admin`), so the preset's `src` include globs resolve against
 * the app root without an explicit `root`.
 */
export default defineSlateUnitConfig({ name: '@slate/admin:unit' });
