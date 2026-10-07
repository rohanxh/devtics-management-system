# Architecture

Devtics Management System (DMS) is an internal ERP: one shared relational data model, many role-specific
interfaces. This document records the architecture and the reasoning behind it.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 24, TypeScript (type-stripping, no server build step) | One language end to end; Node 24 runs `.ts` directly (`erasableSyntaxOnly`). |
| API | Fastify 5 | Fast, small, first-class hooks for auth/CSRF, schema-friendly, `inject()` for tests. |
| Database | PostgreSQL (production) / PGlite (dev & tests) | Relational integrity, triggers for audit, JSONB where it genuinely fits. PGlite is real Postgres compiled to WASM, so dev/test run the same SQL, migrations and triggers without Docker. |
| ORM / migrations | Drizzle ORM + drizzle-kit | Typed SQL-first queries; migrations are plain SQL files in `drizzle/`, reproducible and reviewable. |
| Validation | Zod 4 | Request validation generated from resource metadata. |
| Web | React 19 + Vite + React Router 7 + TanStack Query + Tailwind 4 | SPA served by the API in production; desktop-first, responsive. |
| Charts | Recharts | |

The environment this was built in had Node + npm + git only (no Docker/Postgres), which is why PGlite is the
local default. Production **must** use PostgreSQL (`DATABASE_URL`); the server refuses to start in production without it.

## Layout

```
src/server/
  index.ts            entrypoint (listen + scheduler)
  bootstrap.ts        wires DB (migrate + system seed), event processor, storage, HTTP app
  app.ts              Fastify app: security headers, auth/CSRF hook, error handling, SPA hosting
  routes.ts           registers all route modules
  config.ts           env validation
  jobs.ts             in-process scheduler (outbox drain + periodic jobs)
  db/                 schema/*.ts (Drizzle), client, migrations runner, system + demo seeds
  auth/               password hashing, sessions, auth routes
  rbac/               permission catalog, default role grants, actor loading
  core/               context/transactions, audit, events (outbox + automation engine),
                      notifications, approvals, storage, counters, errors
  resources/          the generic resource engine + resource definitions (defs/*.ts)
  modules/            bespoke routes/services per business area (admin, collab, platform, …)
src/web/
  main.tsx            router + providers
  lib/                api client, metadata context, formatting, navigation, extension registry
  components/         UI kit, metadata-driven list/form/detail/kanban, collaboration panels
  pages/              screens (dashboards, admin, module pages)
drizzle/              SQL migrations (generated + custom, e.g. audit triggers)
tests/                Vitest integration tests (in-memory PGlite, Fastify inject)
docs/                 this documentation
```

## Core ideas

### 1. One canonical data model
Every business entity has exactly one table. Modules reference each other through foreign keys
(e.g. a project references the canonical `clients` row that CRM, Finance and Support also use).
Polymorphic tables (`comments`, `files`, `activities`, `approvals`) attach to any entity by
`(entity_type, entity_id)`; their authorization always flows from the parent record.

### 2. Resource engine (`src/server/resources`)
Most entities are declared once with `defineResource({...})`: table, fields (type, label, validation,
list/filter/search flags, field-level permissions), record-level scope rules, state machine, assignee
fields, numbering, child relations. From that single definition the engine provides:

- `GET /api/r/:key` — scoped list with search, filters (`field=`, `field__gte/lte`, `__null`), sort, pagination
- `GET /api/r/:key/:id`, `POST`, `PATCH`, `DELETE`, `POST /bulk`, `GET /export.csv`, `GET /options`
- Zod validation, mass-assignment protection (read-only/unknown fields ignored), field-level read/write checks
- Record-level authorization (`own` / `team` / `all` scopes) on every read and write, 404 on out-of-scope IDs
- Foreign-key visibility checks (you cannot attach a record to a parent you cannot see)
- State-machine enforcement for status fields
- Domain events (`<key>.created|updated|status_changed|stage_changed|assigned|deleted`) and activity entries
- Metadata (`GET /api/meta`) that drives the generic UI (lists, forms, detail pages, kanban boards)

Bespoke workflows (onboarding, invoicing, QA runs, …) are implemented as services/routes in
`modules/` and reuse the same authorization helpers (`getOne`, `isVisible`, `scopeCondition`).

### 3. Audit at the database layer
`drizzle/0001_audit_triggers.sql` installs an `AFTER INSERT/UPDATE/DELETE` trigger on every business
table (attached automatically after each migration run). Each change writes before/after JSON, changed
fields, the actor (`app.user_id` set per transaction by `withActor`) and request id. `audit_logs` rejects
UPDATE/DELETE/TRUNCATE. Application-level events (login, logout, permission and role changes, password
resets) are written explicitly. See SECURITY.md.

### 4. Events, automation and notifications
Writes emit domain events into the `domain_events` outbox **in the same transaction**. An in-process
`EventProcessor` drains the outbox and evaluates `automation_rules` (event type + payload conditions →
ordered named actions). All actions for one event run in one transaction (retried up to 5 times).
Actions are registered in code (`registerAction`) and rules are data (seeded, admin-toggleable).
Notifications are permission-aware: recipients who cannot see the referenced record are skipped, and a
per-user dedupe key prevents repeats. See WORKFLOWS.md.

### 5. Approvals
`approvals` is a generic request table (kind, entity, approver role or user). Decision handlers are
registered per kind (`registerApprovalHandler`) and run in the decision transaction. Self-approval is
blocked; rejections require a reason.

### 6. Configurable pipelines
`pipeline_stages` holds the stages of every pipeline (project lifecycle, sales, content, recruitment).
Stages carry a stable `key` (used by automation conditions) and an editable name/order/colour, so the
lifecycle is configurable without code changes.

## Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Monolith with modular boundaries, single package | Internal tool, small team; avoids distributed complexity. Module boundaries live in `modules/` + `resources/defs/`. |
| D2 | Session cookies (httpOnly, SameSite=Lax) instead of JWT | Server-side revocation, no token storage in JS. |
| D3 | CSRF via required `X-Requested-With` header + Origin check | OWASP "custom request header" defence; no CORS is enabled. |
| D4 | scrypt (N=2^17,r=8,p=1) from Node stdlib | OWASP-recommended parameters, no native dependency. |
| D5 | Audit via DB triggers | Cannot be bypassed by application code paths. |
| D6 | Transactional outbox + in-process worker | Reliable side effects without extra infrastructure. Upgrade path: `SKIP LOCKED` claiming or a queue when running multiple instances. |
| D7 | Generic resource engine + metadata-driven UI | ~80 entities; one well-tested enforcement point beats dozens of hand-written CRUD routes. |
| D8 | Money as `numeric(14,2)` strings, single base currency for reporting | Exactness; multi-currency conversion deferred (currency stored per document). |
| D9 | Polymorphic comments/files/activities | Shared collaboration across all modules; authorization delegated to the parent resource. |
| D10 | Users vs employees are separate | Login identity vs HR record; contractors/candidates can exist without logins and vice versa. |
| D11 | Custom dev runner (`scripts/dev.mjs`) | `node --watch` kills the child process on the build machine (Windows). |

## Modules
| Area | Server | Web |
|---|---|---|
| Platform | `modules/admin.ts`, `collab.ts`, `platform.ts`, `core/*` | `pages/Admin.tsx`, `Inbox.tsx`, `components/*` |
| CRM & sales | `resources/defs/crm.ts`, `modules/sales.ts` | `modules/sales.tsx` |
| Delivery | `resources/defs/projects.ts`, `modules/delivery.ts`, `clients.ts` | `modules/delivery.tsx` |
| Engineering & QA | `resources/defs/engineering.ts`, `modules/qa.ts` | `modules/engineering.tsx` |
| Finance | `resources/defs/finance.ts`, `modules/finance.ts`, `costing.ts` | `modules/finance.tsx` |
| HR & strategy | `resources/defs/hr.ts`, `modules/hr.ts`, `kpi.ts` | `modules/hr.tsx` |
| IT | `resources/defs/it.ts`, `modules/it.ts`, `core/secrets.ts` | `modules/it.tsx` |
| Marketing | `resources/defs/marketing.ts`, `modules/marketing.ts` | `modules/marketing.tsx` |
| Support | `resources/defs/support.ts`, `modules/support.ts` | `modules/support.tsx` |
| Knowledge | `resources/defs/kb.ts`, `modules/kb.ts` | `modules/kb.tsx`, `components/Markdown.tsx` |
| Reporting | `modules/reports.ts` (shared metrics + dashboards), `modules/executive.ts` | `modules/executive.tsx` |

Cross-module contracts are explicit and small: `HEALTH_SIGNALS` (modules add client-health penalties),
`registerDashboard` / `registerDashboardExtra`, `registerAction`, `registerApprovalHandler`, `JOBS`, and on the web
`registerPanel` / `registerActions` / `EXTRA_ROUTES` / `DASHBOARDS` / `HOME_WIDGETS`.

## Integrations
No integration is faked. Where external data is expected (Git hosting, analytics, Search Console, rankings) the data
model accepts manual entry and records the `source` (`manual`, `ga4`, `search_console`, `import`) so a connector can
populate the same tables later. Integration points to build next: GitHub webhooks → `pull_requests`/`deployments`;
GA4/Search Console → `traffic_snapshots`/`keyword_rankings`; email inbox → `tickets`; accounting export of
`invoices`/`payments`/`expenses`; password-manager lookups by `vault_reference`.

## Extending

- **New entity**: add a table in `src/server/db/schema/*.ts`, run `npm run db:generate -- --name <name>`,
  add a `defineResource` in `src/server/resources/defs/`, add a nav item in `src/web/lib/nav.ts`.
- **New automation**: register an action (`registerAction`) if needed, add a rule to `RULE_SEEDS` in
  `src/server/modules/rules.ts`.
- **New approval type**: `registerApprovalHandler(kind, { onApproved, onRejected })` and call `requestApproval`.
- **New integration**: implement it as a module behind an interface; never store raw secrets in the DB
  (see SECURITY.md › Credentials).
