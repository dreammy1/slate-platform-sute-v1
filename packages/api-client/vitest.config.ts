import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

/**
 * The unit suite runs in Node (the preset's default): the browser client is
 * exercised through an injected `fetch`, and the server modules are Node code. The
 * server guard is tested by simulating a browser global rather than by pretending
 * to be one.
 */
export default defineSlateUnitConfig({ name: '@slate/api-client:unit' });
