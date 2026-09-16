import { describe, expect, it } from 'vitest';

import {
  DATABASE_URL_VARIABLE,
  DIRECT_URL_VARIABLE,
  POSTGRES_URL_SCHEMES,
  databaseUrl,
  directDatabaseUrl,
  parseDatabaseUrl,
} from './env.ts';

const VALID_URL = 'postgresql://slate:slate_dev_password@localhost:5432/slate?schema=public';
const SECRET = 'slate_dev_password';

describe('parseDatabaseUrl', () => {
  it('accepts a well-formed postgresql URL', () => {
    const parsed = parseDatabaseUrl(VALID_URL, DATABASE_URL_VARIABLE);
    expect(parsed.protocol).toBe('postgresql:');
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.pathname).toBe('/slate');
  });

  it('accepts the postgres:// alias', () => {
    expect(
      parseDatabaseUrl('postgres://u:p@localhost:5432/slate', DATABASE_URL_VARIABLE),
    ).toBeInstanceOf(URL);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => parseDatabaseUrl('not a url', DATABASE_URL_VARIABLE)).toThrow(
      /\[slate\/database\].*DATABASE_URL/,
    );
  });

  it('rejects a non-postgres scheme', () => {
    expect(() =>
      parseDatabaseUrl('mysql://slate:pw@localhost/slate', DATABASE_URL_VARIABLE),
    ).toThrow('mysql:');
  });

  it('rejects a URL without a database name', () => {
    expect(() =>
      parseDatabaseUrl('postgresql://slate:pw@localhost:5432/', DATABASE_URL_VARIABLE),
    ).toThrow(/database/);
  });

  it('never echoes credentials in the error message', () => {
    expect.assertions(1);
    try {
      parseDatabaseUrl(`mysql://slate:${SECRET}@localhost/slate`, DATABASE_URL_VARIABLE);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});

describe('databaseUrl / directDatabaseUrl', () => {
  it('reads the trimmed value from the injected environment', () => {
    expect(databaseUrl({ [DATABASE_URL_VARIABLE]: `  ${VALID_URL}  ` })).toBe(VALID_URL);
    expect(directDatabaseUrl({ [DIRECT_URL_VARIABLE]: VALID_URL })).toBe(VALID_URL);
  });

  it('throws naming the variable when it is missing or blank', () => {
    expect(() => databaseUrl({})).toThrow(new RegExp(DATABASE_URL_VARIABLE));
    expect(() => directDatabaseUrl({ [DIRECT_URL_VARIABLE]: '   ' })).toThrow(
      new RegExp(DIRECT_URL_VARIABLE),
    );
  });

  it('validates before returning, mirroring the throw-on-invalid contract', () => {
    expect(() => databaseUrl({ [DATABASE_URL_VARIABLE]: 'https://wrong.example.com/db' })).toThrow(
      new RegExp(POSTGRES_URL_SCHEMES.join('|').replaceAll(':', ':')),
    );
  });
});
