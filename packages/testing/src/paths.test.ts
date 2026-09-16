import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { findRepoRoot, tryFindRepoRoot } from './paths.ts';

/** The workspace this test file belongs to (`packages/testing`). */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'slate-testing-'));
  temporaryRoots.push(directory);
  return directory;
}

function writeManifest(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('findRepoRoot', () => {
  it('resolves the monorepo root from a nested workspace directory', () => {
    const root = findRepoRoot(packageRoot);

    expect(root).toBe(findRepoRoot());
    expect(root).toBe(resolve(packageRoot, '..', '..'));

    const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ workspaces: expect.arrayContaining(['packages/*']) });
  });

  it('prefers the closest ancestor that declares workspaces', () => {
    const outer = createTemporaryRoot();
    const inner = join(outer, 'inner', 'packages', 'example');
    writeManifest(outer, { name: 'outer-root', workspaces: ['packages/*'] });
    writeManifest(join(outer, 'inner'), { name: 'inner-package' });
    writeManifest(inner, { name: 'example-package' });

    expect(findRepoRoot(inner)).toBe(resolve(outer));
  });

  it('ignores manifests without a workspaces field and fails with a descriptive error', () => {
    const directory = join(createTemporaryRoot(), 'project', 'src');
    writeManifest(join(createTemporaryRoot(), 'project'), { name: 'not-a-monorepo' });

    expect(tryFindRepoRoot(directory)).toBeUndefined();
    expect(() => findRepoRoot(directory)).toThrow(/Unable to locate the Slate monorepo root/);
  });
});
