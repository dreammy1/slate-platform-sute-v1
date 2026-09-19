/**
 * `slate/no-server-import-in-client` (SLATE-300, ADR 008 §1).
 *
 * ESLint cannot express "this module is a client component, so it may not import
 * the server client" with the core `no-restricted-imports` rule: the restriction
 * depends on the `'use client'` directive at the top of the *same* file. This
 * rule reads that directive and then reports a restricted import.
 *
 * It is deliberately tiny and dependency-free: the check is a directive lookup
 * plus an import-source comparison, so there is nothing here that can drift from
 * the platform's boundary rules.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow importing server-only modules from a module marked with the "use client" directive.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Module specifiers (or package prefixes) that are server-only.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      serverImportInClient:
        '"{{source}}" is server-only and cannot be imported from a "use client" module. ' +
        'Move the call into a Server Component, a Route Handler or a server action, and pass ' +
        'the resulting data across the boundary instead (ADR 008).',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const modules = options.modules ?? [];

    /** True when the literal is a restricted module or lives under one. */
    function isRestricted(source) {
      return modules.some((module) => source === module || source.startsWith(`${module}/`));
    }

    /** True when the first statement is the `'use client'` directive. */
    function isClientModule(body) {
      const first = body[0];
      return (
        first !== undefined &&
        first.type === 'ExpressionStatement' &&
        first.expression.type === 'Literal' &&
        first.expression.value === 'use client'
      );
    }

    return {
      Program(node) {
        if (!isClientModule(node.body)) return;
        for (const statement of node.body) {
          if (statement.type !== 'ImportDeclaration') continue;
          const source = statement.source.value;
          if (typeof source === 'string' && isRestricted(source)) {
            context.report({
              node: statement,
              messageId: 'serverImportInClient',
              data: { source },
            });
          }
        }
      },
    };
  },
};
