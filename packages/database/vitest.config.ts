import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * Unit tests for the database abstraction.
 *
 * The suite is hermetic by construction: configuration readers are pure,
 * query logging is asserted against an injected sink, tenant scoping compiles
 * queries against Kysely's DummyDriver, and the migration loader only reads
 * files. No test opens a connection.
 */
export default defineSlateUnitConfig({ name: '@slate/database:unit' });
