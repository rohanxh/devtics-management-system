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

## Sales → delivery
**Lead lifecycle.** `new → contacted → qualified → converted` (or `unqualified`, reason required). *Convert* (`POST /api/sales/leads/:id/convert`, qualified leads only) creates or reuses the company, creates a contact and an opportunity in *Discovery*.

**Opportunity pipeline.** Stage probabilities default per stage (10/25/50/75/100/0). Moving to *Won* requires a value; *Lost* requires a reason. Deals cannot be created directly as won/lost, and an onboarded won deal can no longer change stage.

**Won deal → onboarding** (rule `sales.won_deal_onboarding`, action `sales.onboard_won_deal`, idempotent):
1. Company becomes a client (code, client-since, account manager = deal owner).
2. Project created in stage *Scope* with budget = deal value; the deal's contracts are linked to it.
3. Onboarding record (`bd_handover`) + a high-priority handover task for the BD owner; PMs and the CEO are notified.
4. **BD handover** (`POST /api/onboarding/:id/handover`, ≥20 chars) → `pm_review`; handover task closed; PMs notified.
5. **PM review** (`POST /api/onboarding/:id/pm-review`): assigns PM, tech lead, team, due date, hour budget → `cto_review` and a `technical_feasibility` approval for the CTO role.
6. **CTO approves** → `development_kickoff`; kickoff tasks are created for the PM/tech lead. **CTO rejects** (reason required) → back to `pm_review`.
7. **Start delivery** (`POST /api/onboarding/:id/complete`) → `completed`, project moves to *Design*.

## Delivery rules
- **Tasks**: `todo → in_progress → in_review → qa → done` (+ `blocked`). Starting or completing a task with unfinished dependencies is rejected; a task with open subtasks cannot be completed. `qa → in_progress` counts a QA rejection and flags rework; reopening a done task flags rework. Users without `tasks.assign` can only assign to themselves.
- **Time**: users log their own time (no future dates); cost = hourly cost on that date × hours, snapshotted for profitability.
- **Change requests**: `draft → submitted` opens an approval — PM role for normal, CTO role for major changes; the decision sets `approved`/`rejected`; approved CRs feed the scope-change report.
- **Project enters QA** (rule `projects.enter_qa`): status → *In QA*, QA cycle task created, QA role + PM notified.
- **Escalations**: a project update of kind *escalation* notifies the target role (PM/CTO/CEO) and the PM.

## Scheduled jobs
| Job | Every | Effect |
|---|---|---|
| `projects.flag_delayed` | 60 min | Past-due projects that are on track/at risk become *Delayed* (→ PM + CTO alert). |
| `tasks.deadline_reminders` | 60 min | Due-tomorrow and overdue reminders to assignees (deduplicated per due date). |
| `crm.follow_up_reminders` | 60 min | Due follow-ups to owners. |
| `feedback.flag_overdue` | 60 min | Client review requests past due become *overdue* (client delay + health signal). |
| `clients.recompute_health` | 30 min | Recomputes client health from signals (project delays, overdue feedback, low satisfaction; finance and support add theirs). Changes emit `clients.health_changed` → account manager + CEO alert. |

## Client health
Score starts at 100; each signal subtracts a penalty (delayed project −20, at-risk project −10, overdue feedback −10 each (max −20), average satisfaction < 3 over 180 days −20, …). < 60 → **At risk**, < 80 → **Attention required**, otherwise **Active** (has active work), **Stable** (recent work or new client) or **Inactive**. Signal providers are pluggable (`HEALTH_SIGNALS`).
