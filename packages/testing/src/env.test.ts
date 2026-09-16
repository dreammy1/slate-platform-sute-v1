import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENV_FILE_NAME,
  integrationEnabled,
  isCi,
  loadRootEnv,
  requireTestDatabaseUrl,
  TEST_DATABASE_URL_VARIABLE,
  testDatabaseUrl,
} from './env.ts';

const PROBE_VARIABLE = 'SLATE_TESTING_ENV_PROBE';

const temporaryDirectories: string[] = [];

function createEnvFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'slate-env-'));
  temporaryDirectories.push(directory);
  const path = join(directory, ENV_FILE_NAME);
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeEach(() => {
  delete process.env[PROBE_VARIABLE];
});

afterEach(() => {
  delete process.env[PROBE_VARIABLE];
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('loadRootEnv', () => {
  it('loads variables from an env file without overriding existing ones', () => {
    const path = createEnvFile(`${PROBE_VARIABLE}=from-dotenv\n`);

    expect(loadRootEnv({ path })).toEqual({ path, loaded: true });
    expect(process.env[PROBE_VARIABLE]).toBe('from-dotenv');

    process.env[PROBE_VARIABLE] = 'from-shell';
    expect(loadRootEnv({ path })).toEqual({ path, loaded: true });
    expect(process.env[PROBE_VARIABLE]).toBe('from-shell');

    expect(loadRootEnv({ path, override: true }).loaded).toBe(true);
    expect(process.env[PROBE_VARIABLE]).toBe('from-dotenv');
  });

  it('reports a missing env file instead of throwing', () => {
    const path = join(createEnvFile(`${PROBE_VARIABLE}=ignored\n`), '..', 'missing.env');

    expect(loadRootEnv({ path })).toEqual({ path, loaded: false });
    expect(process.env[PROBE_VARIABLE]).toBeUndefined();
  });
});

describe('test database configuration', () => {
  it('treats unset and blank values as not configured', () => {
    expect(testDatabaseUrl({})).toBeUndefined();
    expect(testDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: '   ' })).toBeUndefined();
    expect(integrationEnabled({})).toBe(false);
  });

  it('trims the configured connection string', () => {
    const url = 'postgresql://slate:slate@localhost:5432/slate_test';

    expect(testDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: `  ${url}  ` })).toBe(url);
    expect(integrationEnabled({ [TEST_DATABASE_URL_VARIABLE]: url })).toBe(true);
  });

  it('explains how to provision a database when none is configured', () => {
    expect(() => requireTestDatabaseUrl({})).toThrow(
      new RegExp(`${TEST_DATABASE_URL_VARIABLE} is not set`),
    );
    expect(
      requireTestDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: 'postgresql://localhost/slate_test' }),
    ).toBe('postgresql://localhost/slate_test');
  });
});

describe('isCi', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
    ['true ', true],
  ])('maps CI=%o to %o', (value, expected) => {
    expect(isCi(value === undefined ? {} : { CI: value })).toBe(expected);
  });
});
