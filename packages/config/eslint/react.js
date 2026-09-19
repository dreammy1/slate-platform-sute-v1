const globals = require('globals');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const eslintConfigPrettier = require('eslint-config-prettier');

const base = require('./base.js');
const noServerImportInClient = require('./rules/no-server-import-in-client.js');

/**
 * Server-only packages (ADR 008 §1). A browser bundle, a client component or the
 * design system must never reach any of them: tenant context, the database and
 * the API pipeline all live on the server, and importing them into the frontend
 * is how a frontend starts making authorization decisions it cannot make.
 */
const SERVER_PACKAGES = [
  '@slate/api',
  '@slate/auth',
  '@slate/database',
  '@slate/jobs',
  '@slate/media',
  '@slate/notifications',
  '@slate/search',
  '@slate/settings',
  '@slate/tenant-context',
];

/** Subpath forms of the same packages, so `@slate/api/server` cannot slip through. */
const SERVER_PATTERNS = SERVER_PACKAGES.flatMap((name) => [name, `${name}/**`]);

/** The server half of the API client: same rule, expressed as its own module. */
const SERVER_CLIENT_ENTRY = '@slate/api-client/server';

/** The message every boundary violation reports. */
const BOUNDARY_MESSAGE = (reason) =>
  `${reason} It is server-only: call it from a Server Component, a Route Handler or a ` +
  'server action, and pass the resulting data across the boundary (ADR 008 §1).';

/**
 * The local boundary rule, registered once. Flat config allows a plugin in more
 * than one config block only when it is the *same object*, so both the `.tsx`
 * block and the client-boundary block reference this instance.
 */
const slatePlugin = { rules: { 'no-server-import-in-client': noServerImportInClient } };

/**
 * React, Next.js and frontend-boundary rules (SLATE-300, ADR 008).
 *
 * Scope note: `eslint-plugin-react` is intentionally **not** used. Its current
 * release declares a peer range of `eslint ^3 || … || ^9.7`, so installing it in a
 * repository pinned to ESLint 10 breaks `npm install` for everyone. The rules that
 * actually carry security weight here — hooks correctness, the rendering-safety
 * ban on `dangerouslySetInnerHTML`, and the import boundaries — are enforced with
 * `eslint-plugin-react-hooks` (which does support ESLint 10), a core
 * `no-restricted-syntax` selector and a small local rule instead.
 *
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = tseslint.config(
  ...base,

  {
    name: 'slate/react',
    files: ['**/*.tsx'],
    languageOptions: {
      // A .tsx file runs in a browser or in React's server renderer; `globals.node`
      // from the node preset stays available for tooling that shares the extension.
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      slate: slatePlugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Rendering safety (ADR 008 §2): tenant-authored text is rendered as text.
      // Without eslint-plugin-react's `react/no-danger`, the AST selector pins the
      // same guarantee using core rules only.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is not allowed: tenant-authored content must be rendered ' +
            'as text (ADR 008 §2).',
        },
      ],
    },
  },

  {
    name: 'slate/react/client-boundary',
    // Any module that declares itself a client component. This block also covers
    // `.ts`, so the plugin is registered here as well: flat config only exposes a
    // plugin to the files its own config object matches.
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { slate: slatePlugin },
    rules: {
      'slate/no-server-import-in-client': [
        'error',
        { modules: SERVER_PATTERNS.concat([SERVER_CLIENT_ENTRY]) },
      ],
    },
  },

  {
    name: 'slate/react/server-only-packages',
    // The apps and the design system reach the platform only through
    // `@slate/api-client`; neither may import a server package directly. The two
    // exceptions are the app's designated *server zones* — the versioned API
    // mount and the wiring module it uses — which exist precisely to host the
    // platform on the app's own origin (ADR 008 §5). Everything else in an app,
    // including every component and page, stays on the client half.
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    ignores: ['apps/**/src/app/api/**', 'apps/**/src/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: SERVER_PATTERNS,
              message: BOUNDARY_MESSAGE('This package is part of Slate Core.'),
            },
          ],
        },
      ],
    },
  },

  {
    name: 'slate/react/ui-is-presentational',
    // No authority in the UI package (ADR 008 §4): it may render what it is told
    // to render, and may not know how to talk to the platform at all.
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: SERVER_PATTERNS,
              message: BOUNDARY_MESSAGE('This package is part of Slate Core.'),
            },
            {
              group: ['@slate/api-client', `${SERVER_CLIENT_ENTRY}/**`],
              message: BOUNDARY_MESSAGE('The API client belongs to the apps.'),
            },
          ],
        },
      ],
    },
  },

  // Must stay last: switches off every rule that would fight Prettier, including
  // any introduced above.
  { name: 'slate/react/prettier-compat', ...eslintConfigPrettier },
);
