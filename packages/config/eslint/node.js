const globals = require('globals');
const tseslint = require('typescript-eslint');

const base = require('./base.js');

/**
 * Base config plus Node.js globals for TypeScript sources, for server-side
 * packages and services (`packages/db`, `packages/core`, `packages/api-contracts`, ...).
 *
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = tseslint.config(...base, {
  name: 'slate/node',
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: {
    globals: { ...globals.node },
  },
});
