# 005 — Transactional Notifications

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Slate architecture, security review
- **Tags:** notifications, jobs, providers, tenancy, Phase 2
- **Master Plan refs:** Sections 15, 62, 63; ADR 004; SLATE-206 in `docs/phase2-agent-tasks.md`

## Context and sequencing

The Slate platform requires a reliable mechanism for sending transactional notifications (emails, SMS) triggered by system events or user actions. These must be durable: a failure in the external provider must not cause the originating domain transaction to roll back, nor should the notification be lost.

Following the completion of SLATE-205 (Background Jobs), we now have a durable, tenant-bound execution engine. Notifications are a primary consumer of this engine. By implementing a "Transactional Outbox" pattern—where the notification request is enqueued as a job within the same transaction as the domain change—we ensure atomicity and guaranteed eventual delivery.

## Architectural choices

| Option                        | Integration                                          | Reliability                                                             | Decision                  |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| Synchronous API calls         | Simple `fetch` in handler                            | High risk of domain rollback on provider timeout; no native retry       | Reject                    |
| Separate Notification Service | Dedicated service + MQ                               | High reliability; adds significant infrastructure complexity            | Defer                     |
| Jobs-backed Outbox            | Enqueue `@slate/notifications` job via `@slate/jobs` | Atomic persistence with domain; leverages existing retry/recovery logic | **Propose for SLATE-206** |

## Proposed decision

### Provider-Agnostic Delivery

Create `packages/notifications` (`@slate/notifications`). This package will define a `NotificationProvider` interface:

- `sendEmail(to: string, template: string, params: record): Promise<MessageId>`
- `sendSms(to: string, body: string): Promise<MessageId>`

Concrete implementations for providers (e.g., SendGrid, Twilio, AWS SES) will be injected at the host level. The core package remains provider-agnostic.

### Integration with `@slate/jobs`

The notification flow follows this sequence:

1. **Enqueue**: The domain handler calls `notifications.enqueue(tenantId, type, payload)`. This internally calls `jobs.enqueue` with a `notification.deliver` job type.
2. **Execute**: The `@slate/jobs` worker picks up the job and invokes the `@slate/notifications` handler.
3. **Deliver**: The handler resolves the template, selects the active provider for the tenant, and attempts delivery.
4. **Handle Outcome**:
   - Success: Job marks as succeeded.
   - Transient Failure (e.g., 429, 503): Job schedules retry via existing backoff logic.
   - Permanent Failure (e.g., 400 Invalid Email): Job marks as failed immediately to avoid useless retries.

### Security and Tenancy

- **Tenant Isolation**: Each notification job carries the `tenantId`. Providers are configured per-tenant or via system-wide defaults.
- **Data Privacy**: Notification payloads in the jobs table must follow the redaction rules established in ADR 004.
- **Rate Limiting**: Leverage the worker concurrency limits from `@slate/jobs` to avoid overwhelming providers.

## Consequences and out of scope

- **Positive**: Guaranteed delivery, no domain-blocking I/O, provider swapability without changing domain logic.
- **Costs**: Dependency on the jobs queue; slight delay between domain commit and actual delivery.
- **Deferred**: User preference management (opt-out/opt-in), template versioning/editing UI, delivery tracking (webhooks for "delivered/opened"), multi-channel orchestration (email then SMS).

## Acceptance and validation

The SLATE-206 contract must prove:

- Atomic enqueue of notification alongside domain write.
- Successful delivery via a mocked provider.
- Retry logic triggered by provider transient errors.
- Immediate failure on provider permanent errors.
- Tenant-specific provider configuration is respected.
- `npm run verify` clean.
