# Expenser

A weekly expense tracker for managing personal budgets in Argentine Pesos (ARS).

## Monorepo Structure

This is a [Turborepo](https://turbo.build) + [pnpm workspaces](https://pnpm.io/workspaces) monorepo.

```
expenser/
├── apps/
│   ├── webapp/          # Astro + React + Tailwind frontend
│   └── backend/         # Fastify + Prisma + SQLite REST API
├── package.json         # Root scripts and workspace config
├── pnpm-workspace.yaml
└── turbo.json
```

## Requirements

- Node.js >= 22.12.0
- pnpm >= 10

## Getting Started

Install all dependencies from the root:

```sh
pnpm install
```

Run all apps in development mode:

```sh
pnpm dev
```

Or run a specific app:

```sh
pnpm --filter @expenser/webapp dev
pnpm --filter @expenser/backend dev
```

---

## apps/webapp

**Stack:** Astro 6, React 19, Tailwind CSS 4

A client-side expense tracker that runs entirely in the browser. Data is persisted in `localStorage`.

### Features

- Weekly budget of 100,000 ARS (configurable)
- Carry-over logic: leftover or overspent balance rolls into the next week
- Expense categories with color badges (configurable)
- Settings screen to manage allowance and categories

### Structure

```
apps/webapp/
├── public/
├── src/
│   ├── components/
│   │   ├── App.tsx               # Root component, manages view state and config
│   │   ├── Header.tsx            # Sticky header with settings/home toggle
│   │   ├── ExpenseTracker.tsx    # Home view: balance card + expense form + list
│   │   └── SettingsScreen.tsx    # Settings view: allowance and category editor
│   ├── layouts/
│   │   └── Layout.astro          # Base HTML layout
│   ├── lib/
│   │   └── data.ts               # Types, localStorage helpers, carry-over logic
│   ├── pages/
│   │   └── index.astro           # Entry page
│   └── styles/
│       └── global.css            # Tailwind import
├── astro.config.mjs
└── tsconfig.json
```

### Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start dev server at `http://localhost:4321` |
| `pnpm build` | Build for production to `dist/` |
| `pnpm preview` | Preview the production build |

---

## apps/backend

**Stack:** Fastify 5, TypeScript, Prisma 6 — SQLite locally, [Turso](https://turso.tech) (hosted libSQL) in production via the Prisma libSQL driver adapter.

A REST API following a controller/service architecture (similar to NestJS).

### Structure

```
apps/backend/
├── prisma/
│   └── schema.prisma      # Prisma schema (SQLite datasource)
├── src/
│   ├── lib/
│   │   └── prisma.ts      # Prisma client singleton
│   ├── modules/
│   │   └── health/
│   │       ├── health.controller.ts   # Route registration
│   │       └── health.service.ts      # Business logic
│   ├── app.ts             # Fastify app factory
│   └── server.ts          # Entry point
├── Dockerfile             # Multi-stage build for Cloud Run
├── .env.example
├── package.json
└── tsconfig.json
```

### Architecture

Each feature is a **module** with two files:

- **Controller** — registers routes on the `FastifyInstance`
- **Service** — contains the business logic, called by the controller

To add a new module, create `src/modules/<name>/<name>.controller.ts` and `<name>.service.ts`, then register the controller in `src/app.ts` with `app.register(...)`.

### Environment Variables

Copy `.env.example` to `.env` before running:

```sh
cp apps/backend/.env.example apps/backend/.env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | `file:./dev.db` | SQLite path used by the **Prisma CLI** (migrations/generate) |
| `TURSO_DATABASE_URL` | `file:./prisma/dev.db` | Runtime DB connection used by the libSQL adapter. In production a `libsql://…turso.io` URL |
| `TURSO_AUTH_TOKEN` | — | Turso auth token. Required only for remote (`libsql://`) databases |
| `PORT` | `3001` | Port the server listens on (Cloud Run injects `8080`) |
| `WEBAPP_URL` | `http://localhost:4321` | Allowed CORS origin (the frontend URL) |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` in production so session cookies require HTTPS |
| `SESSION_COOKIE_SAMESITE` | `lax` | Cookie `SameSite` policy. Use `none` if the API and frontend are on different sites |

### Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start dev server at `http://localhost:3000` (with watch) |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` | Run the compiled build |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:migrate` | Run database migrations (local dev) |
| `pnpm db:turso:sql` | Print the full schema as SQL (for applying to Turso) |
| `pnpm deploy` | Build the image via Cloud Build and deploy to Cloud Run |

---

## Deployment

The backend runs on **GCP Cloud Run** with the database on **Turso**. There is no CI/CD — deploys are run manually from your machine. Images are built by **Cloud Build** (no local Docker required) from the multi-stage [`apps/backend/Dockerfile`](apps/backend/Dockerfile), using the repo root as build context (see [`cloudbuild.yaml`](cloudbuild.yaml)).

The target project, region, Artifact Registry repo, and service name live in [`apps/backend/.env.deploy`](apps/backend/.env.deploy) and are read by [`deploy.sh`](apps/backend/deploy.sh) — edit that file to point at a different environment.

| Resource | `.env.deploy` key | Value |
| :--- | :--- | :--- |
| GCP project | `GCP_PROJECT` | `juan-custom-apps` |
| Region | `GCP_REGION` | `us-central1` |
| Artifact Registry repo | `AR_REPO` | `containers` |
| Cloud Run service | `SERVICE_NAME` | `expenser-backend` |
| Custom domain | — | `https://expenser-api.juanromerodev.com` |
| Database | — | Turso DB `expenser` (libSQL) |
| Secrets | — | `TURSO_AUTH_TOKEN` → Secret Manager (`turso-auth-token`) |

### Prerequisites (one-time)

```sh
# Load the deploy config so the commands below stay in sync with .env.deploy
set -a && source apps/backend/.env.deploy && set +a

# Authenticate and select the project
gcloud auth login
gcloud config set project "$GCP_PROJECT"

# Enable APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# Artifact Registry repo
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker --location="$GCP_REGION"

# Store the Turso token as a secret + grant the runtime service account access
printf "%s" "$(turso db tokens create expenser)" | \
  gcloud secrets create turso-auth-token --data-file=-
PNUM=$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding turso-auth-token \
  --member="serviceAccount:${PNUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Apply the schema to Turso

Prisma can't run `migrate deploy` against a remote `libsql://` URL, so apply the schema as raw SQL via the Turso CLI:

```sh
pnpm --filter @expenser/backend db:turso:sql > /tmp/init.sql
turso db shell expenser < /tmp/init.sql
```

### Redeploy (the common case)

After code changes, from `apps/backend`:

```sh
pnpm deploy
```

This runs [`deploy.sh`](apps/backend/deploy.sh), which reads `.env.deploy`, builds a fresh image via Cloud Build, and rolls out a new Cloud Run revision. Existing env vars and secrets are preserved across deploys.

### Updating environment variables

Env vars live on the Cloud Run service, not in the image — change them without rebuilding:

```sh
gcloud run services update "$SERVICE_NAME" --region "$GCP_REGION" \
  --update-env-vars KEY=VALUE
```

The production service sets: `TURSO_DATABASE_URL`, `WEBAPP_URL`, `SESSION_COOKIE_SECURE=true`, `SESSION_COOKIE_SAMESITE`, `NODE_ENV=production`, plus the `TURSO_AUTH_TOKEN` secret.

### Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Health check (no DB access) |
