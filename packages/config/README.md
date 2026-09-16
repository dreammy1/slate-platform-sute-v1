# @slate/config

Shared TypeScript, ESLint and Prettier configuration for every workspace in the
Slate Next-Gen Platform monorepo. Keeping the presets in a single workspace
package means all apps and packages are formatted, linted and typechecked
identically, and a rule change only has to be made once.

npm links this package into the workspace automatically (`packages/*` is part of
the root `workspaces` field) — nothing is published to a registry.

## TypeScript presets

| Preset                                      | Use case                                                              |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `@slate/config/tsconfig/base.json`          | Universal strict preset for server-side / platform packages.          |
| `@slate/config/tsconfig/nextjs.json`        | Next.js apps (`apps/slate-app`, `apps/control-plane`, `apps/public`). |
| `@slate/config/tsconfig/react-library.json` | React component packages (`packages/ui`).                             |

A workspace extends a preset in its own `tsconfig.json`:

```json
{
  "extends": "@slate/config/tsconfig/base.json",
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

Conventions baked into `base.json`:

- `strict` plus the additional safety flags `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and
  `useUnknownInCatchVariables`.
- `verbatimModuleSyntax` and `isolatedModules`, so every file can be transpiled
  in isolation (required by Next.js/SWC and by any future bundler).
- `module`/`moduleResolution` set to `ESNext`/`Bundler`, matching how workspace
  packages are consumed (as TypeScript source, bundled by the app).
- `noEmit`, because compilation is owned by Next.js or the app bundler; type
  checking is performed by `npm run typecheck`.
- `target`/`lib` of `ES2023`.

## ESLint configs

| Config                      | Use case                                                        |
| --------------------------- | --------------------------------------------------------------- |
| `@slate/config/eslint/base` | Language-agnostic JavaScript and TypeScript rules.              |
| `@slate/config/eslint/node` | `base` plus Node.js globals for server-side TypeScript sources. |

The root `eslint.config.js` builds on `@slate/config/eslint/node`, and workspace
packages inherit it automatically: ESLint resolves the nearest config file by
walking up the directory tree, so a package only needs its own
`eslint.config.js` if it must diverge.

Notes:

- The repository is CommonJS by default (the root `package.json` has no
  `"type": "module"`), so `.js`/`.cjs` files are parsed as CommonJS with Node
  globals and TypeScript files are parsed as ES modules.
- `eslint-config-prettier` is applied last so formatting is never linted.
- Rules come from `@eslint/js` recommended, `typescript-eslint` recommended and
  stylistic, plus a small set of repository rules. Type-aware (`...TypeChecked`)
  presets are intentionally not enabled yet: they require every linted file to be
  covered by a `tsconfig.json`, which will be worth adding once real sources
  exist.

## Prettier config

`@slate/config/prettier` is re-exported by the root `prettier.config.js`, so one
configuration applies to the whole repository (Prettier looks up the nearest
config file from each file it formats).

## Adding a new workspace

1. Create the package under `apps/` or `packages/`.
2. Extend the matching TypeScript preset in its `tsconfig.json`.
3. Add a `typecheck` script (`tsc --noEmit -p tsconfig.json`); add `lint`,
   `test` and `build` scripts when the package has them.
4. Run `npm install` from the repository root so npm links the new workspace.

Adding a new preset (for example an ESLint React/Next.js config, or a
`tsconfig/node.json` for code that emits real Node ESM) requires a pull request —
presets are only added together with the workspace that verifies them.
