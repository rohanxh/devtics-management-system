# Deployment

## Requirements
- Node.js ≥ 24
- PostgreSQL ≥ 15 (production). PGlite is used automatically for development/tests when `DATABASE_URL` is unset.
- A writable, backed-up directory for uploaded files (`STORAGE_DIR`).
- A TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer…).

## Configuration (environment variables)
| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | Set `production` in production (Secure cookies, trust proxy, requires `DATABASE_URL`). |
| `PORT` | 4000 | |
| `APP_ORIGIN` | http://localhost:5173 | Public origin; used for CSRF origin checks. |
| `DATABASE_URL` | — | `postgres://user:pass@host:5432/db` |
| `PGLITE_DIR` | .data/pglite | Dev only. |
| `STORAGE_DIR` | storage/uploads | Private file storage. |
| `SESSION_IDLE_HOURS` / `SESSION_MAX_DAYS` | 12 / 7 | |
| `AUTH_RATE_PER_MIN` | 10 | Login / password-change attempts per IP per minute. |
| `SMTP_URL`, `MAIL_FROM` | — | Optional email delivery (see WORKFLOWS › Notifications). |

## Build & run
```bash
npm ci
npm run build            # builds the SPA into dist/web (served by the API)
npm run db:migrate       # applies SQL migrations + attaches audit triggers
npm start                # migrations + system seed also run at startup (idempotent)
```
The API serves the built SPA and falls back to `index.html` for client routes.

## First administrator
There is no default account in production. Create the first admin with a one-off SQL/script session, e.g.
run `npm run db:seed` **only in a non-production database** for demo data, or insert a user and assign the
`admin` (and `ceo`) role, then sign in and use Admin › Users for everyone else. A dedicated
`create-admin` CLI is on the roadmap (see PROJECT_STATUS.md).

## Local development
```bash
npm install
npm run db:seed -- --reset   # fresh PGlite DB with fictional demo data; credentials → .data/seed-credentials.txt
npm run dev                  # API on :4000 (restarts on change)
npm run dev:web              # Vite on :5173 (proxies /api)
npm test                     # integration tests (in-memory Postgres)
npm run typecheck
```

## Migrations
- Schema lives in `src/server/db/schema/*.ts`. Generate SQL with `npm run db:generate -- --name <change>`.
- Custom SQL (triggers, functions) via `npx drizzle-kit generate --custom --name <name>`.
- Migrations are forward-only and tracked in the `drizzle.__drizzle_migrations` table.

## Backups
Back up PostgreSQL (PITR recommended) and `STORAGE_DIR` together; file rows reference storage keys.
