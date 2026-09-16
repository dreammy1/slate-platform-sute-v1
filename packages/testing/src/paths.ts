import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

/** Field that identifies the monorepo root `package.json`. */
const ROOT_MARKER_FIELD = 'workspaces';

function declaresWorkspaces(packageJsonPath: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) {
      return false;
    }
    return Array.isArray((manifest as Record<string, unknown>)[ROOT_MARKER_FIELD]);
  } catch {
    // An unreadable or malformed package.json is simply not the root.
    return false;
  }
}

/**
 * Walks up from `startDir` looking for the monorepo root, identified by a
 * `package.json` with a `workspaces` field.
 *
 * @returns the absolute repository root, or `undefined` when the walk reaches
 * the filesystem root without a match.
 */
export function tryFindRepoRoot(startDir: string = process.cwd()): string | undefined {
  let current = resolve(startDir);
  const { root } = parse(current);

  for (;;) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate) && declaresWorkspaces(candidate)) {
      return current;
    }
    if (current === root) {
      return undefined;
    }
    current = dirname(current);
  }
}

/**
 * Same as {@link tryFindRepoRoot} but throws a descriptive error when the
 * monorepo root cannot be found, which is never the desired state for tooling
 * that needs to resolve repository-level files such as `.env`.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  const root = tryFindRepoRoot(startDir);
  if (root === undefined) {
    throw new Error(
      `[slate/testing] Unable to locate the Slate monorepo root (a package.json with a "workspaces" field) by walking up from "${resolve(startDir)}".`,
    );
  }
  return root;
}
