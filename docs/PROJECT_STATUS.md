# Project status

_Last updated: 2026-10-08_

> **Session start checklist:** read this file → `git log --oneline -20` → `npm install` → `npm test` →
> `npm run typecheck` → check "In progress" and "Next steps" below → continue from there.

## Current phase
**Phase 1 — Platform foundation: complete.** Next: Phase 2 (CRM + Sales) and Phase 3 (Clients + Projects).

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

## In progress
- Nothing partially implemented.

## Remaining work (by phase)
- Phase 2 CRM + Sales: companies, contacts, leads, opportunities pipeline, requirements, communications, follow-ups,
  quotes (+ items), proposals, contracts/SOWs, sales targets, commissions, won-deal onboarding workflow.
- Phase 3 Clients + Projects: clients + health, projects (lifecycle stages + status), members, milestones, tasks,
  subtasks, dependencies, checklists, time entries, risks/issues, change requests, meeting notes, updates,
  client feedback, project dashboard & reports, My Work.
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

## Security considerations
See SECURITY.md. Open items: MFA, email-based reset, upload AV scanning, shared rate-limit store.

## Next recommended steps
1. Phase 2 schema + resources (CRM/sales) with lead→opportunity conversion and won-deal onboarding workflow.
2. Phase 3 projects/tasks with lifecycle automation and the PM / developer dashboards.
3. Then Phase 4–11 in order; keep docs and tests updated per phase.
