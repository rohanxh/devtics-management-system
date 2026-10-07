# API

JSON over HTTPS under `/api`. Authentication is a session cookie set by `POST /api/auth/login`.
Every mutating request must send `X-Requested-With: dms`. Errors have the shape
`{ "error": { "code": "...", "message": "...", "details": { "field": "message" } } }` with HTTP
400 (bad request), 401 (unauthenticated), 403 (forbidden / CSRF), 404 (not found or out of scope),
409 (conflict / in use), 422 (validation failed), 429 (rate limited), 500 (internal, with a reference id).

## Auth
| Method | Path | |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → sets cookie; `{ok, mustChangePassword}` |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | current user, roles, permissions (`{perm: scope}`) |
| POST | `/api/auth/change-password` | `{currentPassword, newPassword}` |

## Metadata & search
| GET | `/api/meta` | user, visible resources with field metadata and allowed actions, pipelines, public settings |
|---|---|---|
| GET | `/api/search?q=` | grouped, permission-filtered global search |
| GET/POST/DELETE | `/api/views` | per-user saved list views |

## Generic resources — `/api/r/:resource`
| Method | Path | Notes |
|---|---|---|
| GET | `/api/r/:key` | `q`, `sort` (`field` / `-field`, comma-separated), `page`, `pageSize` (≤200), filters `field=value[,value]`, `field__gte=`, `field__lte=`, `field=__null`, `mine=1`, `id__in=` |
| GET | `/api/r/:key/:id` | record + `_labels` (reference titles) + `_can` (edit/delete on this record) |
| POST | `/api/r/:key` | create (201) |
| PATCH | `/api/r/:key/:id` | partial update; status transitions validated |
| DELETE | `/api/r/:key/:id` | soft or hard delete (409 if referenced) |
| POST | `/api/r/:key/bulk` | `{ids[], action: 'update'|'delete', data?}` — per-record authorization, per-record results |
| GET | `/api/r/:key/export.csv` | same filters as list; requires export permission |
| GET | `/api/r/:key/options` | `q`, `ids` → `[{id,label}]` for pickers |
| GET/POST | `/api/r/:key/:id/comments` | `{body, mentions?: userId[]}` |
| DELETE | `/api/comments/:id` | author only |
| GET/POST | `/api/r/:key/:id/files` | multipart upload (`file`), `?category=&expiresOn=` |
| GET/DELETE | `/api/files/:id` | authorized download / delete |
| GET | `/api/r/:key/:id/activity` | human-readable activity feed |
| GET | `/api/r/:key/:id/audit` | audit history (requires `audit.view`) |

The list of resources and their fields is discoverable at runtime from `/api/meta`.

## Notifications & approvals
| GET | `/api/notifications?unread=1` | latest 50 + unread count |
|---|---|---|
| POST | `/api/notifications/:id/read`, `/api/notifications/read-all` | |
| GET | `/api/approvals?status=&scope=mine|all` | |
| POST | `/api/approvals/:id/decide` | `{decision: 'approved'|'rejected', note}` (note required to reject) |

## Administration
| GET | `/api/admin/permissions` | permission catalog |
|---|---|---|
| GET/POST | `/api/admin/roles` | list (with grants) / create |
| PUT | `/api/admin/roles/:id/permissions` | `{grants: [{permission, scope}]}` |
| DELETE | `/api/admin/roles/:id` | non-system roles without users |
| POST | `/api/admin/users` | `{name, email, roleKeys[], employeeId?}` → `{id, temporaryPassword}` |
| GET/PUT | `/api/admin/users/:id/roles` | |
| POST | `/api/admin/users/:id/reset-password` | → `{temporaryPassword}` |
| GET | `/api/admin/audit` | filters: `table, action, actor, record, from, to, page` |
| GET/PATCH | `/api/admin/automation[/:id]` | rules + action catalog; enable/disable, edit conditions/actions |
| GET/PUT | `/api/admin/settings` | |

Module-specific endpoints are documented in the sections below as modules are added.
