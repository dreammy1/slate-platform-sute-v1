const nodeConfig = require('@slate/config/eslint/node');
const reactConfig = require('@slate/config/eslint/react');

/**
 * Root ESLint flat config for the whole monorepo. Workspace packages inherit
 * this configuration automatically because ESLint resolves the nearest config
 * file by walking up the directory tree.
 *
 * The React layer (SLATE-300, ADR 008) is composed here rather than in each app
 * because `eslint .` from the repository root uses this file for every file in
 * the tree: a nested config would never be read.
 *
 * @type {import('eslint').Linter.Config[]}
 */
module.exports = [...nodeConfig, ...reactConfig];
