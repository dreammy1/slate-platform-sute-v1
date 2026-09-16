import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * Unit tests for the observability baseline.
 *
 * The suite is hermetic by construction: clocks, sinks and transports are
 * injected, so no test depends on a network call, a real error-monitoring
 * service or a database.
 */
export default defineSlateUnitConfig({ name: '@slate/observability:unit' });
