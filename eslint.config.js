const nodeConfig = require('@slate/config/eslint/node');

/**
 * Root ESLint flat config for the whole monorepo. Workspace packages inherit
 * this configuration automatically because ESLint resolves the nearest config
 * file by walking up the directory tree.
 *
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = [...nodeConfig];
