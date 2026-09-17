# Current Status

- Current Phase: Phase 2 (Slate Core)
- Last Completed Task: **SLATE-204 — System settings & feature flags**
  (`agent:backend` + `agent:security`), per `docs/phase2-agent-tasks.md`.
  ADR 003 is **Accepted**. Created `packages/settings` (`@slate/settings`)
  with dotted-key validation, type-preserving settings, tenant-scoped queries,
  and a code-owned flag registry. Resolution is tenant override, registry
  default, then `false` for undeclared keys; no resolved-value caching is used.
  Migration `0005_system_settings_and_feature_flags.sql` adds `system_setting`
  and `feature_flag`, with mandatory tenant ownership and unique `(tenant_id, key)`
  indexes. Both tables are registered in the typed schema and `TENANT_OWNED_TABLES`.
  The four configuration API routes require their matching permissions and
  record exactly one attributed audit row per accepted write in the same
  transaction. `settings.updated` and `feature.flag.updated` publish only after
  commit and carry keys, never values. The HTTP adapter supports PUT and the
  OpenAPI stub documents all four routes. Invalid keys and malformed URL
  encoding are rejected before a transaction opens. Authorized flag override
  commands accept `enabled: boolean | null`; null restores the registry default.
  Permissions are seeded in integration fixtures following SLATE-202; production
  role provisioning remains the host application's responsibility.
  The **Configuration → Isolation → Audit** gate is green.
- Next Task: **SLATE-205 planning in progress — Background jobs & task queue**
  under `packages/jobs` (`@slate/jobs`). ADR 004 and the task contract in
  `docs/phase2-agent-tasks.md` are drafted for review; ADR 004 remains **Proposed**.
  Jobs are selected before notifications/media to provide durable transactional
  enqueue, tenant-bound execution, retries and recovery on existing PostgreSQL.
  Implementation has not started and requires ADR acceptance. The proposed gate
  is **Enqueue → Isolation → Recovery → Audit**; no queue behavior is yet verified.
  Phase 2 remains open. Audit extraction, notifications, media, search abstraction
  and health checks remain SLATE-206+; the UI step belongs to Phase 4.
  This planning change is intended for a local-only commit, not a push.
- Validation: **`npm run verify` completed with exit code 0 on 2026-09-17**.
  Formatting, lint, typecheck and build passed. Unit tests: **307 passed**
  (API 10, auth 19, database 48, observability 80, settings 108,
  tenant-context 19, testing 23). Isolated PostgreSQL integration tests:
  **56 passed** (API 13, auth 5, database 6, settings 19,
  tenant-context 8, testing 5). Root `npm test` also completed with exit 0.
  Coverage includes typed round-trips, migration upgrade, unknown-flag fallback,
  permission denial/revocation, tenant isolation, audit rollback and post-commit events.
- Blockers: None for SLATE-204. Earlier runner failures were not reproduced in
  the successful final verification run; no runner configuration was changed.
  The in-process event bus remains best-effort, not a durable outbox. Settings
  are configuration, not secret storage; flag targeting, entitlements and UI
  remain outside this milestone.
