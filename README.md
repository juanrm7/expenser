# Expenser

A weekly expense tracker for managing personal budgets in Argentine Pesos (ARS).

## Monorepo Structure

This is a [Turborepo](https://turbo.build) + [pnpm workspaces](https://pnpm.io/workspaces) monorepo.

```
expenser/
├── apps/
│   ├── webapp/          # Astro + React + Tailwind frontend
│   └── backend/         # Fastify + Prisma + SQLite REST API
├── deploy/             # Droplet deploy script, pm2 config, nginx server blocks
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
| `PORT` | `3001` | Port the server listens on |
| `HOST` | `0.0.0.0` | Interface to bind. pm2 sets `127.0.0.1` in production so only nginx can reach it |
| `WEBAPP_URL` | `http://localhost:4321` | Allowed CORS origin (the frontend URL) |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` in production so session cookies require HTTPS |
| `SESSION_COOKIE_SAMESITE` | `lax` | Cookie `SameSite` policy. `lax` works for `expenser.*` + `expenser-api.*` (same site); `none` only if they're on different sites |

### Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start dev server at `http://localhost:3000` (with watch) |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` | Run the compiled build |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:migrate` | Run database migrations (local dev) |
| `pnpm db:turso:sql` | Print the full schema as SQL (for applying to Turso) |

---

## Deployment

Both apps run on a single **DigitalOcean droplet**, with the database on **Turso**. Deploys are manual
(no CI/CD): SSH into the droplet and run the deploy script.

| Piece | How it runs | URL |
| :--- | :--- | :--- |
| Webapp | Static Astro build in `/var/www/expenser`, served by nginx | `https://expenser.juanromerodev.com` |
| Backend | `node dist/server.js` under **pm2** on `127.0.0.1:3001`, reverse-proxied by nginx | `https://expenser-api.juanromerodev.com` |
| Database | Turso DB `expenser` (libSQL) | — |

Everything lives in [`deploy/`](deploy):

- [`deploy/deploy.sh`](deploy/deploy.sh) pulls, installs, builds both apps, `rsync`s the webapp to the web root, and reloads pm2
- [`deploy/ecosystem.config.cjs`](deploy/ecosystem.config.cjs) is the pm2 process definition (loads `apps/backend/.env`)
- [`deploy/nginx/`](deploy/nginx) has one server block per domain

### One-time droplet setup

```sh
# System packages (Ubuntu)
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx rsync git build-essential
# Node 22+ (e.g. via nvm or NodeSource), then pnpm + pm2
corepack enable && corepack prepare pnpm@10 --activate
npm install -g pm2

# Firewall: only SSH + HTTP(S)
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable

# Code + web root (owned by the deploy user so deploy.sh can write without sudo)
git clone git@github.com:juanrm7/expenser.git ~/expenser && cd ~/expenser
sudo mkdir -p /var/www/expenser && sudo chown "$USER" /var/www/expenser

# Production env files (gitignored)
cp apps/backend/.env.example apps/backend/.env   # then edit, see below
echo 'PUBLIC_BACKEND_URL=https://expenser-api.juanromerodev.com' > apps/webapp/.env
```

Production `apps/backend/.env`:

```sh
TURSO_DATABASE_URL=libsql://<db>-<org>.turso.io
TURSO_AUTH_TOKEN=<turso db tokens create expenser>
PORT=3001
WEBAPP_URL=https://expenser.juanromerodev.com
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAMESITE=lax
```

nginx + TLS:

```sh
sudo cp deploy/nginx/expenser.conf deploy/nginx/expenser-api.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/expenser.conf /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/expenser-api.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# After DNS points at the droplet:
sudo certbot --nginx -d expenser.juanromerodev.com -d expenser-api.juanromerodev.com
```

First deploy, then make pm2 survive reboots:

```sh
pnpm run deploy
pm2 startup   # prints a sudo command, run it
pm2 save
```

**DNS:** in DigitalOcean → Networking → Domains → `juanromerodev.com`, point the `expenser` and
`expenser-api` **A** records at the droplet's IP.

### Redeploy (the common case)

```sh
ssh <droplet> 'cd ~/expenser && pnpm run deploy'
```

(Use `run deploy`, not `deploy`, since bare `pnpm deploy` is a built-in pnpm command.) Set `BRANCH=...`
to deploy something other than `main`, or `WEB_ROOT=...` for a different nginx root.

To change backend env vars, edit `apps/backend/.env` and run
`pm2 reload deploy/ecosystem.config.cjs --update-env`. Changing `apps/webapp/.env` requires a
redeploy, because the values are baked into the build. Logs: `pm2 logs expenser-backend`.

### Apply the schema to Turso

Prisma can't run `migrate deploy` against a remote `libsql://` URL, so apply the schema as raw SQL via the Turso CLI:

```sh
pnpm --filter @expenser/backend db:turso:sql > /tmp/init.sql
turso db shell expenser < /tmp/init.sql
```

### Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Health check (no DB access) |
