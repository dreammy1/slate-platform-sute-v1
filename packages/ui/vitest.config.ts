import { defineSlateUnitConfig } from '@slate/testing/vitest/unit';

// Component tests run in `jsdom` (ADR 008 §6). The shared preset already
// matches every `*.test.tsx` file under `src/` (including nested folders) and
// supports the `jsdom` environment, so this only selects it and installs the
// polyfills Radix primitives need in a DOM-less test runner.
export default defineSlateUnitConfig({
  name: '@slate/ui:unit',
  environment: 'jsdom',
  setupFiles: ['src/test-setup.ts'],
});
