# 001 — Database & Query Toolkit

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Slate architecture
- **Tags:** database, typescript, observability, security, Phase 2
- **Master Plan refs:** Section 13 (never trust client-provided IDs), Section 14
  (core domain model), Section 15 (`database abstraction` is a core
  capability, listed alongside `audit`, `permissions`, `jobs`, not as an ORM),
  Section 79 (auditability, controlled execution, tenant isolation), Section 61
  (observability baseline).

## Context

Phase 2 (Slate Core) needs a **database abstraction** layer. The Master Plan
(Section 15) lists exactly one database-related core capability, and it is
worded deliberately: `database abstraction` — not an ORM. Section 79 frames the
non-functional requirements that are non-negotiable here:

- **Auditability** — every query against the database must be attributable and
  redactable. The observability baseline (`@slate/observability`) already
  scrubs secrets and redacts sensitive _keys_; the same guarantees must apply to
  SQL logging.
- **Controlled execution** — a query that crosses tenant boundaries must not be
  expressible by accident.
- **Tenant isolation** — every query must carry the request-scoped tenant, and a
  tenant must never read another tenant's rows.

The repository also imposes four hard technical constraints:

1. **Strictest-possible TypeScript.**
   `packages/config/tsconfig/base.json` enables `strict`, `noUncheckedIndexedAccess`,
   `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`,
   `verbatimModuleSyntax`, `noUnusedLocals` and `noUnusedParameters`. The
   chosen tooling must not fight these flags or require `// @ts-expect-error`
   by day one.
2. **`pg` is already a dependency.**
   `@slate/testing` depends on `pg@^8.23.0` and exposes a `Client` from `pg`
   to suites. A toolkit that runs on `pg` reuses that driver and the existing
   schema-per-suite harness; a second Postgres driver adds bundle size and a
   second failure surface.
3. **CI must stay lean.**
   `npm ci` installs from the lockfile with no native-binary build step and no
   `postinstall` codegen. `typescript-eslint@8.70.0` declares
   `typescript >=4.8.4 <6.1.0`, so anything that drags a second `typescript`
   into the tree is disqualifying.
4. **Observability must be pluggable, not opinionated.**
   The monitor speaks the Sentry envelope protocol over an injectable
   transport; the DB layer must hand query events to the project logger rather
   than writing its own logs.

## Options considered

### 1. Prisma

Good for apps that value an opinionated ORM with a relations graph and
auto-generated CRUD. Here it is a poor fit:

- Ships a **native query engine** per platform (`postinstall`/CI codegen,
  binary download). Contradicts constraint 3.
- Type generation is excellent in general but historically produces types that

### 2. Drizzle

A schema-as-code SQL mapper that infers types from `pg`-shaped schemas.
Fits constraints 2 and 3 (pure JS, runs on `pg`) but:

- Younger ecosystem → fewer eyes on security, and type inference under
  `noUncheckedIndexedAccess` still surfaces `T | undefined` for array/dynamic
  access, generating null-check churn under the strict config.
- **No per-query lifecycle hook.** The only instrumentation surface is a
  global logger callback, which cannot be correlated per-request (no
  `requestId` child logger) — weak for constraint 4.
- Tenant scoping still has to be built by us; Drizzle offers no compositional
  edge over a raw builder for that.

Usable, but no advantage over option 3 and strictly weaker on observability.

### 3. Kysely

The query builder was _designed_ for strict TypeScript and produces airtight
inferred types from a `Kysely<Database>` interface, working naturally with
`noUncheckedIndexedAccess` and index-signature access. It runs on `pg` (constraint 2),
is pure JS with no native binary and no codegen (constraint 3), and is
**SQL-first** — queries are explicit strings/identifiers composed through a
builder, never hidden behind an ORM.

It is the best direct fit:

- **Observability (constraint 4):** `onQuery` fires per query with the parsed
  SQL and parameters; the `log` config accepts a `(entry) => void` that the
  project can route through a child logger bound with the request id. Parameters
  are separate from SQL text, so redaction of secret values in bound parameters
  is centralized and auditable — exactly the model the logger already uses.
- **Tenant isolation (constraints, Section 13/79):** a thin query helper can
  compose any user query with `where: { tenant_id: scope.tenantId }` and a
  `search_path`-per-request setup; the builder makes the scoping explicit at
  the call site rather than implicit in middleware.
- **Auditability:** because the SQL is authored (not generated), it is
  reviewable the same way the existing `infrastructure/postgres/init/` seed
  SQL is.
- **Migrations:** migrations stay raw, hand-written SQL files (auditable, like
  the init bootstrap) driven by a minimal runner or `kysely-ctl`; no hidden
  state and no binary.

Trade-off accepted: Kysely is **not a full ORM** (no relations graph, no lazy
loading, no auto-gen CRUD resolvers). The plan asks for a _database
abstraction_, and explicitly keeps "database abstraction" distinct from heavier
concerns — so the trade-off is aligned, not a loss.

### 4. Raw `pg`

Already a dependency and trivially strict-safe. Rejected as the _primary_
abstraction because it offers no type inference on rows (every result is cast
by hand) and no central choke point to guarantee tenant scoping on each query —
a single missed `where tenant_id = ?` is a data-isolation bug, and there is no
builder to make omission structurally visible.

## Decision

**Adopt Kysely (`kysely`) on top of `pg`, with hand-written SQL migrations and
per-query logging wired through `@slate/observability`.**

- A shared `packages/database` workspace owns the `Kysely<Database>` interface,
  the typed column interfaces per schema, the connection factory and the
  tenant-scoped query helper introduced by SLATE-200/SLATE-201.
- Query logging flows through `onQuery` → a child logger bound with the request
  id, with parameter values run through the existing `redactValue` +
  `scrubSecrets` layer before they reach the sink (no plaintext secrets in logs
  — Section 61).
- Migrations live as raw `.sql` files (reviewable, auditable).
- `@slate/testing/postgres`'s `pg`-based schema harness is reused unchanged
  for integration tests.

### Alternatives considered but deferred

- An ORM (Prisma) may be reconsidered **only if** the strictest-TS friction or
  the native-engine concern is resolved; today neither holds.
- A full relations-model layer (e.g. Prisma relations) is out of scope — tenant
  scoping stays explicit in the builder so a bypass is at least visible and
  testable (Section 65 adversarial cases).

## Consequences

- One Postgres driver (`pg`), no codegen, no native binary in CI.
- DB queries log through the project logger with redaction; errors that reach
  the monitor carry the same redacted context.
- All future DB code carries the request id and tenant id at the type level —
  the `(db, tenantId) =>` helper signature is the unit where isolation is
  enforced and tested.

  _bite_ `exactOptionalPropertyTypes` (nullable vs optional field semantics are
  a frequent source of `// @ts-expect-error`), and the strict config already
  turns on every flag that exposes those cracks.

- Observability goes through Prisma's **own** logging path (`log: [...]`) that
  bypasses the `@slate/observability` logger and is hard to redact, because the
  query-engine layer is opaque.
- The relations-graph "magic" is exactly the kind of implicit SQL that
  Section 79's "controlled execution" and "auditability" push against: a tenant
  filter added by convention instead of in code is a latent bypass.

Disqualifying for this posture.
