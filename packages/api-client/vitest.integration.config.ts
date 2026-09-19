import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

/**
 * Proves the browser path end to end: the route handler mounted exactly as the
 * Next.js app mounts it, a real PostgreSQL schema through `@slate/testing`, and
 * the browser client driving it over HTTP.
 */
export default defineSlateIntegrationConfig({ name: '@slate/api-client:integration' });
