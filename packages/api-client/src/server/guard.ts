/**
 * The server-only guard (SLATE-300, ADR 008 §5).
 *
 * Every module on the server half of the client imports this first and calls it at
 * module scope. If the module graph is ever evaluated with a DOM present — because
 * a Client Component imported it by mistake, or a bundler mis-split a chunk — the
 * import fails immediately instead of shipping a privileged path to the browser.
 *
 * The ESLint rule `slate/no-server-import-in-client` prevents the mistake; this
 * guard is what makes it *loud* if prevention fails. It is a small, dependency-free
 * module on purpose: it has to be safe to import from anywhere.
 */

/** Throws when the caller is running where a browser global exists. */
export function assertServerOnly(moduleName: string): void {
  if (typeof window !== 'undefined' || typeof document !== 'undefined') {
    throw new Error(
      `${moduleName} is server-only and must never be evaluated in a browser. ` +
        'Import the root entry (@slate/api-client) from Client Components, or move the ' +
        'call into a Server Component, a Route Handler or a server action (ADR 008 §5).',
    );
  }
}

/** True when a DOM is present — exported so tests can assert the guard's premise. */
export function isBrowserLike(): boolean {
  return typeof window !== 'undefined' || typeof document !== 'undefined';
}
