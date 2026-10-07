# Project status

_Last updated: 2026-10-08_

> **Session start checklist:** read this file → `git log --oneline -20` → `npm install` → `npm test` →
> `npm run typecheck` → check "Known issues" and "Next recommended steps" below → continue from there.

## Current phase
**All 11 planned phases are implemented** (foundation → executive reporting) with integration tests.
The system is in a **hardening / refinement** phase: see "Next recommended steps".

## Completed functionality
| Phase | Scope (all with schema, API, permissions, UI, workflow, audit, tests) |
|---|---|
| 0 Discovery | Stack & architecture decisions (ARCHITECTURE.md). Node 24 + Fastify + PostgreSQL/PGlite + Drizzle + React. |
| 1 Foundation | Auth (scrypt, sessions, lockout, rate limits, forced password change), CSRF, CSP, RBAC with scoped grants + field-level rules + anti-escalation, DB-trigger audit (append-only), resource engine, comments/files/activity, event outbox + automation rules, notifications (dedupe, permission-aware, email digests), approvals, admin console, saved views, global search. |
| 2 CRM & Sales | Canonical companies, contacts, leads (conversion), opportunities pipeline, requirements, communications, follow-ups, quotes (SQL totals), proposals, contracts/SOWs, targets, commissions, BD dashboard. |
| 3 Clients & Projects | Client view + computed health, won-deal → onboarding workflow (BD → PM → CTO → kickoff), projects (stages + status), members, milestones, tasks/subtasks/checklists/dependencies, time with cost snapshots, risks/issues, change requests (PM/CTO approval), meeting notes, updates/escalations, client feedback, PM & developer dashboards, My Work. |
| 4 Dev & QA | Repositories, environments, PRs/code review, deployments (prod → CTO approval), bugs (QA-controlled lifecycle), QA template library, test cases, QA runs, fail-and-raise-bug, sign-off gating launch, tech reviews (CTO), tech debt, tech stack, CTO & QA dashboards, developer quality metrics. |
| 5 Finance | Invoices/payments (payment-driven status, overdue job), recurring billing, expenses/payables (four-eyes), compensation history, adjustments, payroll runs (preparer ≠ approver), payslips, profitability, P&L, AR aging, MRR, finance dashboard. |
| 6 HR & Strategy | Employee sub-records, private HR documents, attendance (clock in/out, absences), leave (balances, working days, manager approval), reviews, training, recruitment pipeline + hire automation, goals/OKRs, KPIs (auto-measured), initiatives, company risks, HR dashboard. |
| 7 IT | Assets + assignment history, SaaS/licenses with seats, infrastructure with expiry tracking, access records, offboarding automation, secrets guard (vault references only), IT dashboard. |
| 8 Marketing | Campaigns with lead attribution, traffic, keywords + rankings, backlinks, SEO audits, content pipeline, ranking-drop alerts, marketing dashboard. |
| 9 Support | Tickets with SLA policies/targets, breach job, escalation to tasks/bugs with automatic status sync, maintenance plans (hours usage, auto recurring billing), support dashboard. |
| 10 Knowledge | Versioned articles, required reading by audience, per-version acknowledgements, compliance view, review reminders, safe Markdown, KB UI. |
| 11 Executive reporting | CEO dashboard; financial, profitability (project & client), sales, delivery, utilization, people, engineering, support and KPI reports; CSV export. |
| Ops | `create-admin` CLI, demo seed (fictional), email digests (SMTP or log). |

Tests: **83 integration tests** across 12 files (auth, RBAC/audit, sales→projects, QA/engineering, finance, HR, IT,
marketing, support, KB, notifications, reports) — all passing at the time of writing.

## In progress
- Nothing partially implemented.

## Remaining work / not yet built
- **Git push**: blocked — see Blockers.
- Integrations (documented interfaces only, no fake integrations): GitHub (PRs/deployments), GA4/Search Console (traffic,
  rankings), accounting export, Slack, calendar, password-manager API lookups, email-to-ticket.
- API tokens for machine-to-machine access (sessions only today).
- MFA (TOTP) for privileged roles; self-service password reset by email.
- Client portal (clients viewing their tickets/invoices).
- Business-hours SLA calendars; per-location time zones for attendance (currently server time).
- Multi-currency conversion (currency stored per document; reports assume the base currency).
- Front-end code splitting (bundle > 500 kB warning) and an end-to-end browser test suite.

## Known bugs / limitations
- `node --watch` is unreliable on the Windows dev machine → `scripts/dev.mjs` runner.
- Rate limiting, scheduler and event worker are single-process (ARCHITECTURE D6).
- Generic `/api/r/kb_articles` is editor-only; readers use `/api/kb`.
- Lesson recorded: in single-table Drizzle selects, `${table.col}` renders unqualified — correlated subqueries must
  name the outer column explicitly (fixed in `f6a0a8f`, regression-tested).

## Database / migrations
| Migration | Content |
|---|---|
| 0000_foundation | identity, RBAC, org, settings, pipelines, audit, outbox, rules, notifications, comments, activities, files, approvals, saved views |
| 0001_audit_triggers | audit trigger function, append-only guard, `attach_audit_triggers()` |
| 0002_counters | document number counters |
| 0003_crm_projects | CRM, sales, projects, tasks, time, risks, CRs, updates, feedback, onboarding, compensation |
| 0004_engineering_qa | repos, environments, PRs, deployments, bugs, QA templates/cases/runs, tech reviews/debt/stack |
| 0005_finance | invoices, payments, recurring billing, expenses, payroll, adjustments |
| 0006_hr_strategy | emergency contacts, skills, certifications, job history, attendance, leave, reviews, training, recruitment, goals, KPIs, initiatives |
| 0007_it | assets, assignments, subscriptions, licenses, infrastructure, access grants |
| 0008_marketing | campaigns, traffic, keywords, rankings, backlinks, SEO audits, content |
| 0009_support | SLA policies/targets, maintenance plans, tickets |
| 0010_knowledge | KB articles, versions, audiences, reading assignments, acknowledgements |

## Security considerations
See SECURITY.md. Open items: MFA, email-based reset, upload AV scanning, shared rate-limit store, DB role separation in production.

## Blockers (need the owner)
- **Git push**: this machine authenticates to GitHub as `m-rohanxh`, which has no write access to
  `rohanxh/devtics-management-system` (HTTP 403). All work is committed locally on `main`. Fix: add `m-rohanxh` as a
  collaborator, or sign Git in as `rohanxh`, then `git push -u origin main`.

## Next recommended steps
1. Resolve the push blocker and set up CI (typecheck + tests + build).
2. Deploy a staging instance on PostgreSQL; run `npm run create-admin`; walk through each role's dashboard.
3. Add API tokens + the first real integration (GitHub webhooks for PRs/deployments).
4. MFA for CEO/CTO/Finance/HR/Admin.
5. Code-split the web bundle per module; add Playwright smoke tests for the main journeys.
