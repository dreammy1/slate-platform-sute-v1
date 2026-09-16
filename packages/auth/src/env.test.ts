import { describe, expect, it } from 'vitest';

import { describeSecrets, hasAuthPepper } from './env.ts';

describe('auth env', () => {
  it('reports an unset pepper without exposing values', () => {
    expect(hasAuthPepper({})).toBe(false);
    expect(hasAuthPepper({ SLATE_AUTH_PEPPER: '   ' })).toBe(false);
    expect(hasAuthPepper({ SLATE_AUTH_PEPPER: 's3cret' })).toBe(true);
    const summary = describeSecrets({ SLATE_AUTH_PEPPER: 's3cret', DATABASE_URL: 'postgres://x' });
    expect(summary).toContain('SLATE_AUTH_PEPPER=set (6 chars)');
    expect(summary).not.toContain('s3cret');
  });
});
