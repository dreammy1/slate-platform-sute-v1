import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * Unit tests for the auth layer.
 *
 * The suite is hermetic by construction: getCurrentUser and the permission
 * evaluator operate on injectable query services (faked in unit tests), so no
 * test opens a connection. Tenant isolation and the Section 65 no-stale-grants
 * invariant are exercised with fakes that model the join chain explicitly.
 */
export default defineSlateUnitConfig({ name: '@slate/auth:unit' });
