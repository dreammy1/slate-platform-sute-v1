import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MIGRATION_FILE_NAME,
  STATEMENT_SEPARATOR,
  loadMigrations,
  migrationChecksum,
  parseMigrationFileName,
  splitStatements,
} from './migrations/index.ts';

const CORE_TABLES = [
  'organization',
  'tenant',
  'app_user',
  'role',
  'permission',
  'role_permission',
  'tenant_membership',
  'audit_log',
  'system_setting',
  'feature_flag',
] as const;

describe('parseMigrationFileName', () => {
  it('parses the NNNN_name.sql convention', () => {
    expect(parseMigrationFileName('0001_organization_and_tenant.sql')).toEqual({
      id: '0001',
      name: 'organization_and_tenant',
    });
  });

  it('rejects malformed file names', () => {
    expect(parseMigrationFileName('001_organization.sql')).toBeUndefined();
    expect(parseMigrationFileName('0001-Bad Name.sql')).toBeUndefined();
    expect(parseMigrationFileName('0002_app_user.txt')).toBeUndefined();
    expect(parseMigrationFileName('bad.sql')).toBeUndefined();
  });
});

describe('splitStatements', () => {
  it('splits on the marker and trims every statement', () => {
    expect(
      splitStatements(`CREATE TABLE a (id int);\n${STATEMENT_SEPARATOR}\n\nCREATE INDEX i;`),
    ).toEqual(['CREATE TABLE a (id int);', 'CREATE INDEX i;']);
  });

  it('drops empty chunks instead of executing them', () => {
    expect(splitStatements(`\n${STATEMENT_SEPARATOR}\n${STATEMENT_SEPARATOR}\n`)).toEqual([]);
  });
});

describe('migrationChecksum', () => {
  it('is deterministic for identical content', () => {
    expect(migrationChecksum('SELECT 1;')).toBe(migrationChecksum('SELECT 1;'));
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT 2;'));
  });
});

describe('loadMigrations', () => {
  const migrations = loadMigrations();

  it('discovers the Phase 2 migrations in dependency order', () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
    ]);
    expect(new Set(migrations.map((migration) => migration.id)).size).toBe(migrations.length);
  });

  it('matches every file against the naming convention', () => {
    for (const migration of migrations) {
      expect(migration.name).toMatch(/^[a-z0-9_]+$/);
      expect(MIGRATION_FILE_NAME.test(`${migration.id}_${migration.name}.sql`)).toBe(true);
    }
  });

  it('creates every Phase 2 core table exactly once', () => {
    const sql = migrations.map((migration) => migration.sql).join('\n');
    for (const table of CORE_TABLES) {
      const matches = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, 'g'));
      expect(matches).toHaveLength(1);
    }
  });

  it('requires every tenant-scoped table to carry a tenant_id', () => {
    const sql = migrations.map((migration) => migration.sql).join('\n');
    for (const table of [
      'role',
      'permission',
      'tenant_membership',
      'audit_log',
      'system_setting',
      'feature_flag',
    ]) {
      const createTable = sql.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([^;]+)\\);`),
      )?.[1];
      expect(createTable).toContain('tenant_id uuid NOT NULL');
    }
  });

  it('produces at least one executable statement per migration', () => {
    for (const migration of migrations) {
      expect(migration.statements.length).toBeGreaterThan(0);
      for (const statement of migration.statements) {
        expect(statement).not.toBe('');
        expect(statement).not.toContain(STATEMENT_SEPARATOR);
      }
    }
  });

  it('keeps checksums stable across loads', () => {
    expect(loadMigrations().map((migration) => migration.checksum)).toEqual(
      migrations.map((migration) => migration.checksum),
    );
  });

  it('rejects files that break the naming convention', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slate-migrations-'));
    try {
      writeFileSync(join(directory, 'not-numbered.sql'), 'SELECT 1;');
      expect(() => loadMigrations(directory)).toThrow(/NNNN_name\.sql convention/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate ordinals', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slate-migrations-'));
    try {
      writeFileSync(join(directory, '0001_first.sql'), 'SELECT 1;');
      writeFileSync(join(directory, '0001_second.sql'), 'SELECT 2;');
      expect(() => loadMigrations(directory)).toThrow(/more than once/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
