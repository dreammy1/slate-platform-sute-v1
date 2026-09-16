const js = require('@eslint/js');
const eslintConfigPrettier = require('eslint-config-prettier');
const globals = require('globals');
const tseslint = require('typescript-eslint');

/**
 * Paths that are never linted: dependencies and generated build output.
 * Kept in the base config so every consumer gets the same ignores.
 */
const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/*.d.ts',
  '**/.eslintcache',
];

/**
 * Language-agnostic ESLint flat config for the Slate monorepo.
 *
 * The repository is CommonJS by default (no `"type": "module"` at the root),
 * so `.js`/`.cjs` files are parsed as CommonJS with Node globals available.
 * TypeScript sources are always parsed as ES modules.
 *
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = tseslint.config(
  { name: 'slate/ignores', ignores },

  {
    name: 'slate/language-options/cjs',
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    name: 'slate/language-options/esm',
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    name: 'slate/language-options/ts',
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,

  {
    name: 'slate/rules',
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    name: 'slate/rules/cjs',
    files: ['**/*.js', '**/*.cjs'],
    rules: {
      // CommonJS tooling configuration legitimately uses require().
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Must stay last: switches off every rule that would fight Prettier.
  { name: 'slate/prettier-compat', ...eslintConfigPrettier },
);
