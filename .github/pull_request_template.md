<!--
Slate Next-Gen Platform - pull request template.

Master Plan references: Section 2 (one phase finishes before the next starts),
Section 7 (branch and merge strategy), Section 12 (Definition of Done),
Section 53 (CI/CD pipeline) and Section 55 (automated GitHub operations).

A reviewer must be able to answer "is the phase gate satisfied?" without
reading the whole diff first. Fill in every section; delete nothing.
-->

## Summary

<!-- One paragraph: what changed and why. -->

Closes #<!-- issue ID, e.g. SLATE-006 -->

## Scope

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| Phase            | <!-- e.g. Phase 2 - Slate Core --> |
| Milestone        | <!-- e.g. M2 Core -->              |
| Agent role       | <!-- e.g. agent:backend -->        |
| Breaking change  | <!-- yes / no -->                  |
| Migration needed | <!-- yes / no / n-a -->            |

## Type of change

- [ ] `type:feature`
- [ ] `type:bug`
- [ ] `type:security`
- [ ] `type:architecture`
- [ ] `type:documentation`
- [ ] `type:test`
- [ ] `type:infrastructure`

## What changed

<!-- Files, packages and contracts touched, with the reasoning behind each. -->

## How to verify

<!-- Exact commands a reviewer runs from a clean clone, and what they observe. -->

```bash
npm ci
npm run verify
```

## Verification evidence

Every gate that exists in this repository must be reported with its observed
result or its CI job link. "N/A" is only acceptable when the command genuinely
cannot run (for example integration tests without a database) - then say why.

| Gate              | Command                    | Result   |
| ----------------- | -------------------------- | -------- |
| Formatting        | `npm run format:check`     | <!-- --> |
| Lint              | `npm run lint`             | <!-- --> |
| Type check        | `npm run typecheck`        | <!-- --> |
| Unit tests        | `npm run test:unit`        | <!-- --> |
| Integration tests | `npm run test:integration` | <!-- --> |
| Build             | `npm run build`            | <!-- --> |

## Definition of Done (Master Plan, Section 12)

- [ ] UI is complete, or explicitly out of scope for this task
- [ ] Backend/API is complete
- [ ] Database schema and migrations are complete, with clean-install, upgrade and migration tests
- [ ] Authentication and authorization are complete
- [ ] Tenant isolation is tested
- [ ] Object ownership checks are tested
- [ ] Validation is complete
- [ ] Error handling is complete
- [ ] Audit logging is implemented where required
- [ ] Unit, integration and E2E tests pass
- [ ] Security tests pass
- [ ] Build passes
- [ ] Clean installation works
- [ ] Upgrade from the previous phase works
- [ ] Documentation is updated (docs/, plus an ADR when architecture changed)
- [ ] CI passes
- [ ] No critical/high blocker remains
- [ ] Independent AI review has passed
- [ ] Human approval is recorded

## Security review

- [ ] No secret, token or credential is committed (`.env` stays git-ignored)
- [ ] No sensitive customer data reaches the logs (Master Plan, Section 61)
- [ ] Tenant and object ownership were considered for every new endpoint
- [ ] Every new dependency was reviewed (license, maintenance, open advisories)
- [ ] Adversarial cases from Section 65 were considered where relevant

## Rollback

<!-- How to revert this change safely, including the database side. -->

## Reviewer notes

<!-- Anything the next agent or reviewer must know: feature flags, contracts, follow-ups. -->
