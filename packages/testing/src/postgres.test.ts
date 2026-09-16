import { describe, expect, it, vi } from 'vitest';

import { TEST_DATABASE_URL_VARIABLE } from './env.ts';
import {
  assertValidSchemaName,
  connectWithSchema,
  createIsolatedDatabase,
  DEFAULT_SCHEMA_PREFIX,
  generateSchemaName,
  quoteIdentifier,
  withIsolatedDatabase,
} from './postgres.ts';

describe('generateSchemaName', () => {
  it('generates a unique, lowercase schema name per suite', () => {
    const first = generateSchemaName();
    const second = generateSchemaName();

    expect(first).toMatch(/^slate_test_[0-9a-f]{12}$/);
    expect(second).toMatch(/^slate_test_[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });

  it('normalizes hostile prefixes instead of embedding them in SQL', () => {
    expect(generateSchemaName('slate_booking')).toMatch(/^slate_booking_[0-9a-f]{12}$/);
    expect(generateSchemaName('Slate CRM; DROP SCHEMA public')).toMatch(
      /^slate_crm_drop_schema_public_[0-9a-f]{12}$/,
    );
    expect(generateSchemaName('   ')).toMatch(
      new RegExp(`^${DEFAULT_SCHEMA_PREFIX}_[0-9a-f]{12}$`),
    );
  });

  it('never exceeds the PostgreSQL identifier limit', () => {
    const name = generateSchemaName('x'.repeat(200));

    expect(name.length).toBeLessThanOrEqual(63);
    expect(assertValidSchemaName(name)).toBe(name);
  });
});

describe('assertValidSchemaName', () => {
  it('rejects names that are not safe identifiers', () => {
    expect(assertValidSchemaName('slate_test_abc')).toBe('slate_test_abc');
    expect(() => assertValidSchemaName('public')).not.toThrow();

    for (const invalid of [
      '',
      'Slate',
      'bad-name',
      'a; DROP SCHEMA public',
      'x'.repeat(64),
      '1abc',
    ]) {
      expect(() => assertValidSchemaName(invalid)).toThrow(/not a valid test schema name/);
    }
  });
});

describe('quoteIdentifier', () => {
  it('escapes embedded double quotes', () => {
    expect(quoteIdentifier('widgets')).toBe('"widgets"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe('connectWithSchema', () => {
  it('fails before opening a connection when the schema name is invalid', async () => {
    await expect(
      connectWithSchema('postgresql://localhost:5432/slate_test', 'bad-name'),
    ).rejects.toThrow(/not a valid test schema name/);
  });
});

describe('createIsolatedDatabase', () => {
  it('refuses to run without an isolated test database', async () => {
    vi.stubEnv(TEST_DATABASE_URL_VARIABLE, '');

    await expect(createIsolatedDatabase()).rejects.toThrow(
      new RegExp(`${TEST_DATABASE_URL_VARIABLE} is not set`),
    );
    await expect(withIsolatedDatabase(async () => 'never reached')).rejects.toThrow(
      /docker compose up -d/,
    );
  });
});
