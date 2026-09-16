# GitHub governance

This document is the single description of how the repository is configured
on GitHub: the CI gates, branch protection, review ownership, labels,
milestones, templates and dependency automation. `.github/CODEOWNERS`,
`.github/dependabot.yml` and the issue templates point here instead of
duplicating the reasoning.

Master Plan references: Section 6 (GitHub as the source of truth), Section 7
(branch and merge strategy), Section 71 (recommended labels), Section 72
(milestones), Section 74 (Day-1 setup) and Section 75 (human roles).

## The CI pipeline (`.github/workflows/ci.yml`)

Seven jobs chained with `needs`: the pipeline can only advance when the
previous gate passed - the phase-gate rule applied to every commit.

| #   | Gate          | Proves                                                                                                                                                                             |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `install`     | A clean clone installs from the lockfile alone (`npm ci`).                                                                                                                         |
| 2   | `lint`        | Formatting (Prettier) and lint (ESLint) are clean.                                                                                                                                 |
| 3   | `typecheck`   | The root config and every workspace typecheck (`tsc --noEmit`).                                                                                                                    |
| 4   | `unit`        | The unit suites pass, with the GitHub reporter on CI.                                                                                                                              |
| 5   | `integration` | Integration suites pass against a real `postgres:16-alpine` service. Only `TEST_DATABASE_URL` is exposed, and a missing URL fails the job - coverage can never silently disappear. |
| 6   | `build`       | Every workspace that has a build script builds.                                                                                                                                    |
| 7   | `security`    | `npm audit --audit-level=high` and a gitleaks scan over the full commit history.                                                                                                   |

A newer push or PR supersedes the in-flight run for the same ref
(`concurrency`), and every job declares least-privilege `permissions`
(`contents: read`).

## Branch and merge strategy

- `main` is the trunk and must always be releasable; all work arrives by
  pull request, never by direct push.
- Branches carry the Agent Task Contract issue id (`SLATE-<id>-<slug>`), so
  branch, commit and project board entry stay linkable.
- One phase finishes before the next starts (Section 2); the pull request
  template asks the reviewer to answer "is the phase gate satisfied?" before
  anything else.

## Branch protection for `main` (Settings -> Branches)

Configure once at Day-1 setup (Section 74); keep this list as the checklist:

- Require a pull request before merging; required approvals: `1`.
- Require review from Code Owners (`.github/CODEOWNERS`).
- Dismiss stale approvals when new commits are pushed.
- Require the seven status checks of the CI pipeline: `install`, `lint`,
  `typecheck`, `unit`, `integration`, `build`, `security`.
- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Require linear history (no merge commits on `main`).
- Do not allow force pushes or deletions.

## Review ownership (`.github/CODEOWNERS`)

Every path currently resolves to `@dreammy1`, the single human maintainer and
final authority for product, architecture, security exceptions and production
releases (Section 75). When an agent role or a second maintainer gains a
GitHub account, replace the handle in the matching block instead of adding
another catch-all rule.

| Paths                                                                             | Owner block                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| everything (default `*`)                                                          | repository owner                                                           |
| `/.github/`, the compose files, `.env.*.example`, `/infrastructure/`              | Agent F - DevOps: pipelines, containers, environment contract              |
| `ARCHITECTURE.md`, `AGENTS.md`, `DEVELOPMENT_STATE.md`, the Master Plan, `/docs/` | Agent A - Architect: the documents every phase gate refers to              |
| `/packages/config/`, `/packages/testing/`, `/packages/observability/`             | Agent G - shared tooling: a change here is reviewed like a contract change |

## Labels (Master Plan, Section 71)

Four families plus the `dependencies` label that automation applies:

| Family      | Values                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type:`     | `feature`, `bug`, `security`, `architecture`, `documentation`, `test`, `infrastructure`                                                                            |
| `area:`     | `core`, `auth`, `crm`, `booking`, `commerce`, `restaurant`, `hotel`, `events`, `projects`, `builder`, `plugin`, `license`, `control-plane`, `ai`, `infrastructure` |
| `priority:` | `critical`, `high`, `medium`, `low`                                                                                                                                |
| `agent:`    | `architect`, `backend`, `frontend`, `qa`, `security`, `devops`, `docs`                                                                                             |
| automation  | `dependencies` (applied by Dependabot)                                                                                                                             |

The issue templates pre-apply the `type:` label and offer `area:`/`agent:`
as dropdowns; create the full set once during Day-1 setup (Section 74).

## Milestones (Master Plan, Section 72)

Milestones mirror the phases one to one: `M0 Architecture Contract`,
`M1 Foundation`, `M2 Core`, `M3 Identity`, `M4 UI Shell`, `M5 Plugin
Platform`, `M6 Licensing`, `M7 Control Plane`, `M8 CRM`, `M9 Booking`,
`M10 Commerce`, `M11 Restaurant`, `M12 Hotel`, `M13 Events`, `M14 Projects`,
`M15 Forms/Media`, `M16 Themes/Templates`, `M17 Builder`, `M18 AI`,
`M19 Marketplace`, `M20 Updates/Support`, `M21 Security`, `M22 Production`,
`M23 Launch`.

## Issue templates (`.github/ISSUE_TEMPLATE/`)

- **Agent task** - the Agent Task Contract (Section 10): issue id, owning
  agent role, goal, scope, _out of scope_, allowed files and packages,
  dependencies, architecture references, contracts, security requirements
  and acceptance criteria. If a field cannot be answered yet, the task is
  not ready and belongs in architecture discussion (Section 11).
- **Bug report** - environment (see `docs/environments.md`), area, severity,
  reproduction steps and the adversarial cases from Section 65.
- **Feature request** - area, phase, scope and out of scope, the readiness
  checklist (Section 11) and a test strategy per level (unit, integration,
  E2E, adversarial).

`config.yml` links the Master Development Plan, the architecture contract,
`DEVELOPMENT_STATE.md` and this guide as contact links.

## Pull request template

The template forces the evidence a reviewer needs before reading the diff: a
scope table (phase, milestone, agent role, breaking change, migration
needed), the type-of-change labels, what changed, the exact commands a
reviewer runs from a clean clone, a gate-by-gate result table (formatting,
lint, typecheck, unit, integration, build) and the Definition of Done
checklist (Section 12) with the security review items.

## Dependency automation (`.github/dependabot.yml`)

| Ecosystem                                           | Schedule          | PR limit | Notes                                                                                                         |
| --------------------------------------------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `npm` (the root lockfile, covering every workspace) | Mondays 05:00 UTC | 5        | Grouped: `tooling`, `typescript`, `testing`, and `production` (minor+patch); `versioning-strategy: increase`. |
| `github-actions`                                    | Mondays 05:15 UTC | 3        | The pinned actions inside the workflows.                                                                      |
| `docker`                                            | Mondays 05:30 UTC | 3        | The Postgres image tags.                                                                                      |

Every dependency pull request is labelled `type:infrastructure` +
`dependencies` and uses the `chore(deps)` / `chore(deps-dev)` / `chore(ci)` /
`chore(infra)` commit-message prefixes.

Two things are deliberately **not** configured in that file:

1. **Dependabot security updates** are a repository setting
   (Settings -> Code security and analysis), not a file entry.
2. **Auto-merge** does not exist: dependency pull requests walk the same
   seven gates and the same human review as every other change - no gate may
   be silently skipped (Section 2).

## Repository security settings checklist

- [ ] Dependabot alerts **and** Dependabot security updates enabled.
- [ ] Secret scanning **and** push protection enabled.
- [ ] Actions default token permissions read-only (workflows additionally
      declare least-privilege `permissions`).
- [ ] Branch protection on `main` per the checklist above.
- [ ] GitHub environments `staging` and `preview` hold the deployment
      secrets (`docs/environments.md`); no secret lives in git.
- [ ] The gitleaks gate scans every push and pull request (full history).

## Releases

The release path is CI -> Staging -> Smoke Test -> Production (Section 53).
The release job stamps `SENTRY_RELEASE` with the deployed tag or commit SHA,
so every error report and log record correlates with the exact build; the
observability contract behind it lives in `docs/observability.md`.
