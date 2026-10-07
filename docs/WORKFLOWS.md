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

## Engineering & QA
- **Project enters QA** → status *In QA*, QA cycle task, QA + PM notified.
- **QA run** (`POST /api/qa/runs`) materialises template checks as project test cases; results are recorded per case.
  *Fail* raises a linked bug in one step. *Complete* requires every case recorded. **Sign-off** requires no failed/blocked
  cases and no open critical/high bugs → project *Ready for launch*, stage *Client Feedback*, `qa_approved_at` set;
  rejection sends the project back to development and notifies PM + tech lead.
- **Launch** (`POST /api/projects/:id/launch`) and moving the stage to Launch/Maintenance require QA sign-off (internal projects exempt).
- **Bugs**: developers move bugs to *fixed*; only QA (`qa.edit`) can move to retest/verified/reopened/closed; reopening counts a retest.
- **Production deployments** open a CTO approval; non-production deployments are approved immediately.
- **Code review**: authors cannot approve their own PR; reviewers are notified on assignment, authors on decision.
- **Technical reviews** (architecture, integration, infrastructure, security) → CTO approval with a decision record.

## Finance
- Invoice status is owned by money: payments move it to partially paid / paid; the hourly job marks overdue ones
  (→ Finance + account manager alert, client-health penalty). Only drafts can be edited or deleted; void needs a reason
  and no payments.
- Completed billable milestones notify Finance; `POST /api/finance/invoices/from-milestone/:id` drafts the invoice.
- Recurring schedules draft invoices on their run date (missed periods are caught up).
- Expenses: submitter ≠ approver; approved & unpaid = payables. Payroll: prepared from salary history + approved
  adjustments; approval must come from someone other than the preparer; adjustments lock once applied.

## HR
- **Leave**: working days exclude weekends (per schedule) and holidays; overlap and balance are checked; the request goes
  to the manager (or HR) as an approval; approval updates the balance and marks attendance *on leave*; cancelling restores both.
- **Attendance**: clock in/out computes late/early/overtime against the work schedule; the job marks absences for the
  previous working day; corrections require HR/manager scope.
- **Reviews**: the employee may only write their self-assessment; completion needs a rating; promotion / salary-review
  recommendations notify HR (and Finance).
- **Hiring**: moving an application to *Hired* (HR only) creates the employee (probation), records the hire, fills the
  opening and notifies HR, IT and Admin; `employee.hired` asks IT to prepare access and equipment.
- **Offboarding**: an employee becoming terminated/resigned sends IT + HR the list of access to revoke and devices to recover;
  the IT dashboard keeps flagging leftovers.

## Support
- Ticket SLA due times come from the plan's SLA policy (or the default) by priority; leaving *new* records the first response;
  the 15-minute job flags breaches (Support, assignee, PM notified).
- *Send to development* / *Log as bug* creates linked work in the project; task/bug progress moves the ticket to *In QA*
  and *Resolved* automatically.
- Maintenance plans create their own recurring billing; time logged on their tickets is "used hours"; 80 % / 100 % usage alerts.

## Knowledge base
- Editing a published article creates a new draft version; readers keep seeing the published one.
- Publishing a required-reading version assigns it to the audience (roles/departments, or everyone) with a due date and
  notifies them; each version needs its own acknowledgement; overdue reading and review dates trigger reminders.

## Additional jobs
| Job | Every | Effect |
|---|---|---|
| `invoices.mark_overdue` | 60 min | Recalculate past-due invoices → overdue. |
| `billing.generate_recurring` | 60 min | Draft invoices from recurring schedules. |
| `attendance.mark_absences` | 120 min | Absent records for yesterday's working day without clock-in. |
| `hr.reminders` | 6 h | Probation ending, reviews due, certifications and employee documents expiring. |
| `kpis.measure` | 6 h | Record automatic KPI values; refresh goals linked to metrics. |
| `it.renewals` | 6 h | Infra expiring/expired status + alerts, subscription renewals, warranty ends. |
| `seo.ranking_drops` | 12 h | Alert on keywords dropping 5+ positions. |
| `support.sla` | 15 min | SLA breach detection. |
| `support.plan_usage` | 6 h | Plan hour usage alerts. |
| `kb.reminders` | 12 h | Overdue required reading; articles due for review. |
| `notifications.email_digest` | 10 min | Email digest of important notifications left unread (SMTP or log). |

## Client health
Score starts at 100; each signal subtracts a penalty (delayed project −20, at-risk project −10, overdue feedback −10 each (max −20), average satisfaction < 3 over 180 days −20, …). < 60 → **At risk**, < 80 → **Attention required**, otherwise **Active** (has active work), **Stable** (recent work or new client) or **Inactive**. Signal providers are pluggable (`HEALTH_SIGNALS`).
