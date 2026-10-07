# Project status

_Last updated: 2026-10-08_

> **Session start checklist:** read this file → `git log --oneline -20` → `npm install` → `npm test` →
> `npm run typecheck` → check "In progress" and "Next steps" below → continue from there.

## Current phase
**Phases 1–3 complete** (foundation, CRM + sales, clients + projects). Next: Phase 4 (Development + QA).

## Completed
### Phase 0 — Discovery & architecture
- Environment: Node 24 + npm + git (no Docker/Postgres) → PostgreSQL in production, PGlite for dev/tests.
- Architecture, data-model strategy, authorization model, workflow/event strategy: see ARCHITECTURE.md.

### Phase 1 — Platform foundation
- Fastify API, Drizzle schema + SQL migrations, PGlite/Postgres client, system seed (roles, grants, pipelines, rules).
- Authentication: scrypt, sessions (idle/absolute expiry, revocation), lockout, rate limiting, forced password change.
- CSRF protection, Helmet security headers/CSP, centralised error handling.
- RBAC: permission catalog, 14 seeded roles, scoped grants, field-level restrictions, anti-escalation rules.
- DB-trigger audit trail (append-only) + application security events; audit viewer.
- Generic resource engine (list/search/filter/sort/paginate/CSV/bulk/options/CRUD, state machines, events, activity).
- Collaboration: comments with mentions, private file storage with authorized download, activity feed, per-record audit.
- Event outbox + automation engine + permission-aware, deduplicated notifications; approvals engine.
- Admin: users (invite with temp password, roles, reset), roles & permission matrix, org structure (departments,
  designations, locations, working hours, holidays), pipeline stages, automation rules, audit log, settings.
- Web: app shell (permission-filtered navigation, global search Ctrl+K, notifications, user menu), login,
  password change, metadata-driven list/detail/form/kanban, approvals inbox, notifications page, admin screens.
- Demo seed: 17 fictional employees across all roles.
- Tests: 22 integration tests (auth, CSRF, lockout, RBAC, IDOR, field-level, state machine, escalation, audit).

### Phase 2 — CRM + Sales
- Companies (canonical org record), contacts, leads (state machine, conversion), opportunities (configurable pipeline, kanban, stage rules),
  requirements, communications, follow-ups (+ reminders), quotes with SQL-computed totals and draft-only editing, proposals,
  contracts/SOWs (MSA hierarchy), sales targets, commissions. BD dashboard (pipeline by stage, month results, win rate, target progress).

### Phase 3 — Clients + Project management
- Clients (view over companies) with computed health (pluggable signals) and alerts.
- Won deal → automated onboarding: client + project + contracts linked + BD handover → PM review → CTO feasibility approval → kickoff tasks → delivery.
- Projects (lifecycle stages + delivery status board), members, milestones, tasks/subtasks/checklists/dependencies (cycle-safe),
  time tracking with cost snapshots, risks/issues, company risk register, change requests with PM/CTO approval, meeting notes,
  daily/weekly updates & escalations, client feedback (overdue tracking).
- Record-aware field restrictions (budget/cost visible only on projects the PM manages).
- Jobs: delayed-project flagging, deadline reminders, follow-up reminders, overdue feedback, client health.
- Dashboards: PM (pipeline counts, portfolio progress/hours, overdue tasks, escalations, team hours), Developer (My Work, hours, delivery quality metrics), BD.
- Tests: 34 integration tests passing.

## In progress
- Nothing partially implemented.

## Remaining work (by phase)
- Phase 4 Dev + QA, Phase 5 Finance, Phase 6 HR, Phase 7 IT, Phase 8 Marketing, Phase 9 Support,
  Phase 10 Knowledge, Phase 11 Executive reporting (see the original brief for scope).
- Email delivery of notification digests (SMTP), MFA, create-admin CLI, API tokens for integrations.

## Known bugs / limitations
- `node --watch` is unreliable on the Windows dev machine → `scripts/dev.mjs` runner used instead.
- Rate limiting and the event worker are single-process (see ARCHITECTURE decisions D6).

## Database / migrations
| Migration | Content |
|---|---|
| 0000_foundation | identity, RBAC, org, settings, pipelines, audit, outbox, rules, notifications, comments, activities, files, approvals, saved views |
| 0001_audit_triggers | audit trigger function, append-only guard, `attach_audit_triggers()` |
| 0002_counters | document number counters |
| 0003_crm_projects | CRM, sales, projects, tasks, time, risks, CRs, updates, feedback, onboarding, compensation |

## Security considerations
See SECURITY.md. Open items: MFA, email-based reset, upload AV scanning, shared rate-limit store.

## Next recommended steps
1. Phase 4: repositories, environments, PRs/code reviews, deployments (prod needs CTO approval), bugs, QA templates/test cases/runs, QA sign-off → ready for launch; CTO + QA dashboards.
2. Phase 5 finance (invoices, payments, expenses, payroll, profitability) — compensation table already exists.
3. Then Phases 6–11.

## Blockers
- **Git push**: this machine authenticates to GitHub as `m-rohanxh`, which lacks write access to `rohanxh/devtics-management-system` (HTTP 403). Commits are local until access is granted.
