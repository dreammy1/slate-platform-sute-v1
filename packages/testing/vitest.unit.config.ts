import { defineSlateUnitConfig } from './vitest/unit.ts';

/**
 * Unit tests for the shared test harness itself.
 *
 * `@slate/testing` dogfoods its own presets: if the unit or integration preset
 * regresses, this workspace is the first thing that stops working.
 */
export default defineSlateUnitConfig({ name: '@slate/testing:unit' });
