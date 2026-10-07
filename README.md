# Devtics Management System

Internal operating system for Devtics: CRM & sales, projects, engineering & QA, finance, HR, IT,
marketing, support and knowledge — one shared data model with role-specific dashboards and
server-enforced permissions.

- **Stack:** Node 24 · Fastify · PostgreSQL (PGlite in dev/tests) · Drizzle · React 19 · Vite · Tailwind
- **Docs:** [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) · [Authorization](docs/AUTHORIZATION.md) ·
  [Workflows](docs/WORKFLOWS.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) · [Deployment](docs/DEPLOYMENT.md) ·
  [Project status](docs/PROJECT_STATUS.md)

## Quick start
```bash
npm install
npm run db:seed -- --reset   # demo data; login credentials written to .data/seed-credentials.txt
npm run dev                  # API  http://127.0.0.1:4000
npm run dev:web              # UI   http://localhost:5173
npm test
```
Demo users are `<name>@devtics.example` — e.g. `ayesha` (CEO), `bilal` (CTO), `hina` (PM), `ali` (developer),
`hamza` (QA), `sara` (finance), `usman` (BD), `rabia` (HR), `imran` (admin), `danish` (IT), `sana` (support),
`kamran` (marketing). All demo data is fictional.
