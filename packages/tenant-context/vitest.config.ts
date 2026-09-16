import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * Unit tests for the tenant context layer.
 *
 * The suite is hermetic by construction: context resolution is a pure
 * function over an injectable principal and header value, tenant-scoped
 * queries compile against Kysely's DummyDriver, and events are asserted on an
 * injected sink. No test opens a connection.
 */
export default defineSlateUnitConfig({ name: '@slate/tenant-context:unit' });
