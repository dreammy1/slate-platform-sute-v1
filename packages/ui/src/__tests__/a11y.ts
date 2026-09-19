import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Accessibility assertion helper (ADR 008 §4: accessibility is a gate).
 *
 * Rules that need a real layout engine or a whole page are disabled rather than
 * asserted: jsdom performs no layout, so `color-contrast` cannot be computed here
 * (it is covered by the token contrast test instead), and `region`/`landmark`
 * describe a complete document rather than a component under test.
 *
 * The helper asserts only *violations*: the query is scoped to the rendered
 * container so the rule set describes the component, not the test harness.
 */
export async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  });

  const violations = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.target.join(' ')),
  }));

  expect(violations).toEqual([]);
}
