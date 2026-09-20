import { defineSlateIntegrationConfig } from '@slate/testing/vitest/integration';

/**
 * Integration suite for the admin feature modules (SLATE-302): the real
 * PostgreSQL tables through `@slate/testing`, proving tenant isolation, audit
 * attribution, the escalation guard and feature-flag mutations. Vitest runs
 * from the package directory, so the preset's globs resolve against the app root.
 */
export default defineSlateIntegrationConfig({ name: '@slate/admin:integration' });
