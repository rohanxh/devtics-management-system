# Database

PostgreSQL schema managed by Drizzle (`src/server/db/schema/*.ts`) with SQL migrations in `drizzle/`.
Conventions: snake_case columns, UUID primary keys (`gen_random_uuid()`), `created_at`/`updated_at`
timestamps (timestamptz), money as `numeric(14,2)`, enums for fixed vocabularies, foreign keys everywhere a
relationship exists, indexes on foreign keys used for filtering.

## Core (Phase 1)
| Table | Purpose |
|---|---|
| `users` | Login identities (email unique case-insensitively, scrypt hash, status, lockout fields). |
| `roles`, `user_roles`, `role_permissions` | RBAC; grants carry a scope (`own`/`team`/`all`). |
| `sessions` | Server-side sessions (token SHA-256, expiry, revocation). |
| `departments`, `designations`, `locations`, `work_schedules`, `holidays` | Organisation structure. |
| `employees` | HR person record (1:0..1 with users), department/designation/manager/location, employment status; private fields are field-level restricted. |
| `settings` | Key/value system settings (JSONB). |
| `pipeline_stages` | Configurable stages for all pipelines (`pipeline`, stable `key`, name, order, colour, terminal/outcome). |
| `audit_logs` | Append-only audit trail (trigger + app events). |
| `domain_events` | Transactional outbox. |
| `automation_rules` | Event → conditions → actions (JSONB config). |
| `notifications` | In-app notifications with per-user dedupe key. |
| `comments`, `activities`, `files` | Polymorphic collaboration attached by `(entity_type, entity_id)`. |
| `approvals` | Generic approval requests. |
| `saved_views` | Per-user saved list filters. |
| `counters` | Atomic counters for document numbers. |

## Design notes
- **One canonical entity per concept.** Modules reference shared tables rather than copying them.
- **Polymorphic tables** do not have FKs to their parents (by design); integrity of access is enforced by
  the parent resource's authorization. Orphans are harmless and can be swept.
- **JSONB is used only for genuinely flexible data**: settings values, automation rule config, audit
  snapshots, event payloads, saved-view queries.
- **Audit triggers** are attached to every public table except high-volume/system tables
  (`audit_logs`, `domain_events`, `notifications`, `sessions`, `activities`, `saved_views`).

Module tables are documented in their sections as they are added.
