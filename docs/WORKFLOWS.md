# Workflows & automation

DMS models business processes as **entity → state → responsible role → action → approval → notification →
audit event → next state**.

## Building blocks
1. **State machines** — resources declare allowed status transitions (`status.transitions`); the API rejects
   others with 422. Pipelines (project lifecycle, sales, content, recruitment) use configurable stages
   (`pipeline_stages`) with stable keys.
2. **Domain events** — every write emits `<resource>.created|updated|status_changed|stage_changed|assigned|deleted`
   (plus module events such as `approval.decided`) into the `domain_events` outbox in the same transaction.
3. **Automation rules** (`automation_rules`) — `event type + payload conditions → ordered actions`. Seeded as
   system rules, toggleable/editable in Admin › Automation. All actions for an event run in one transaction and are
   audited as *System* with request id `event:<id>`; failures retry up to 5 times and keep `last_error`.
4. **Actions** (registered in code): `notify_roles`, `notify_assignee`, `notify_record_users`, plus module actions.
5. **Approvals** — `requestApproval()` creates a request for a role or user and notifies approvers; the decision
   runs the kind's handler in the same transaction and emits `approval.decided`.
6. **Scheduled jobs** — `JOBS` in `src/server/jobs.ts` run periodically (e.g. overdue scans) and emit events.

## Notifications
In-app notifications are permission-aware (recipients who cannot see the record are skipped), never sent to the
person who caused the event, and deduplicated per user with a dedupe key. Kinds: assignment, mention,
approval_request, approval_decided, status, deadline, escalation, alert.

## Rules catalogue
See Admin › Automation for the live list. Module rules are documented with each module below.
