# Expenser

A weekly expense tracker for managing personal budgets in Argentine Pesos (ARS).

## Monorepo Structure

This is a [Turborepo](https://turbo.build) + [pnpm workspaces](https://pnpm.io/workspaces) monorepo.

```
expenser/
├── apps/
│   ├── webapp/          # Astro + React + Tailwind frontend
│   └── backend/         # Rust (axum) + libSQL REST API
├── deploy/             # Droplet deploy script, pm2 config, nginx server blocks
├── package.json         # Root scripts and workspace config
├── pnpm-workspace.yaml
└── turbo.json
```

## Requirements

- Node.js >= 22.12.0
- pnpm >= 10
- Rust (stable, via [rustup](https://rustup.rs)), for the backend

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
- Browse previous Saturday-to-Friday weeks and return to the current week
- Add missed expenses and edit or delete expenses in the selected week
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

**Stack:** Rust, [axum](https://github.com/tokio-rs/axum) 0.8 on tokio, [libSQL](https://github.com/tursodatabase/libsql): a SQLite file locally, [Turso](https://turso.tech) (hosted libSQL) in production.

A REST API with one file per feature, holding its routes, handlers, row types and SQL.

### Structure

```
apps/backend/
├── migrations/
│   └── 0001_init.sql   # Schema migrations, applied in order at startup
├── src/
│   ├── main.rs         # Entry point: config, database, server, graceful shutdown
│   ├── lib.rs          # AppState and the router (CORS, correlation ids, request logging)
│   ├── config.rs       # Environment variables
│   ├── db.rs           # Connection, migrations, query helpers, timestamp encoding
│   ├── error.rs        # AppError ({ "message" } error bodies), JsonBody and Id extractors
│   ├── dates.rs        # Saturday–Friday weeks and months, in the server's time zone
│   ├── auth.rs         # /auth/* routes, sessions, AuthUser/SessionUser extractors
│   ├── api_keys.rs     # /api-keys routes, API key authentication
│   ├── categories.rs   # /categories routes
│   ├── expenses.rs     # /expenses routes, weekly/monthly summary
│   └── mcp.rs          # /mcp: MCP server for AI assistants such as Claude
├── tests/              # API tests against the real router and a temporary database
├── Cargo.toml
└── .env.example
```

### Architecture

- Handlers declare what they need as arguments: `AuthUser` (session cookie or API key, else 401),
  `SessionUser` (session only; 403 for API keys), `JsonBody<T>`, `Id`, `State<AppState>`.
- Queries are plain SQL run through the helpers in `db.rs` (`fetch_all`, `fetch_optional`,
  `fetch_one`, `fetch_value`), which deserialize rows into serde structs by column name. Every
  query is scoped by the user's id.
- Errors are `AppError`s: expected ones carry a status and message; anything else is logged and
  answered with a 500. Every error body is `{ "message": "..." }`.
- Actions the MCP server also offers (adding an expense, editing a category, …) live in plain
  functions such as `expenses::add`, which the REST handler and the MCP tool both call, so they
  validate the same way.

To add a feature, create `src/<name>.rs` with a `routes()` function and merge it in `app()` (`src/lib.rs`).

### MCP server

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI assistants such
as Claude can read and manage your expenses. It speaks MCP's Streamable HTTP transport through the
official [`rmcp`](https://crates.io/crates/rmcp) SDK, without sessions, and authenticates with an
API key: create one in the webapp's settings (a dedicated one, e.g. "Claude", so you can revoke it
on its own).

| Tool | Description |
| :--- | :--- |
| `get_summary` | The current (or a past `weekStart`) week's balance and the month to date, with today's date |
| `list_expenses` | Search by date range, category and description: count, total and per-category totals of every match, plus the newest `limit` (default 100) |
| `add_expense`, `update_expense`, `delete_expense` | Categories are given by name, ignoring case |
| `list_categories`, `add_category`, `update_category`, `delete_category` | |
| `get_profile`, `update_profile` | Name and weekly allowance |

To use it from [Claude Code](https://code.claude.com):

```sh
claude mcp add --transport http expenser https://expenser-api.juanromerodev.com/mcp \
  --header "Authorization: Bearer exp_..."
```

(`http://localhost:3001/mcp` locally.) Adding it as a custom connector in the Claude apps (web,
desktop, mobile) needs OAuth, which the server doesn't support yet.

### Database

The schema lives in [`migrations/`](apps/backend/migrations). Pending migrations are applied
automatically when the server starts, to the local file and to Turso alike, and recorded in the
`_migrations` table. To change the schema, add the next numbered file (e.g. `0002_add_budgets.sql`)
and list it in `MIGRATIONS` in `src/db.rs`. Never edit a migration that has already been applied.

`0001_init.sql` is the schema the previous (Prisma) backend created, so existing databases are
adopted as they are. Timestamps are stored as UTC text in the format Prisma used
(`2026-10-12T03:00:00.000+00:00`).

### Environment Variables

The defaults work for local development. To override them, copy `.env.example` to `.env`:

```sh
cp apps/backend/.env.example apps/backend/.env
```

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TURSO_DATABASE_URL` | `file:./dev.db` | A local SQLite file (created on first start), or in production a `libsql://…turso.io` URL |
| `TURSO_AUTH_TOKEN` | — | Turso auth token. Required only for remote (`libsql://`) databases |
| `PORT` | `3001` | Port the server listens on |
| `HOST` | `0.0.0.0` | Interface to bind. pm2 sets `127.0.0.1` in production so only nginx can reach it |
| `WEBAPP_URL` | `http://localhost:4321` | Allowed CORS origin (the frontend URL) |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` in production so session cookies require HTTPS |
| `SESSION_COOKIE_SAMESITE` | `lax` | Cookie `SameSite` policy. `lax` works for `expenser.*` + `expenser-api.*` (same site); `none` only if they're on different sites |
| `RUST_LOG` | `info` | Log filter, e.g. `debug`. `rmcp` (the MCP SDK) stays at `warn` unless named, e.g. `info,rmcp=info` |

Weeks and months follow the server's local time zone (`TZ`).

### Commands

From `apps/backend` (or `pnpm --filter @expenser/backend <script>` from the root):

| Command | Description |
| :--- | :--- |
| `pnpm dev` (`cargo run`) | Start the API at `http://localhost:3001` |
| `pnpm build` | Release build to `target/release/expenser-backend` |
| `pnpm start` | Run the release build |
| `pnpm test` (`cargo test`) | Run the unit and API tests |
| `cargo clippy --all-targets`, `cargo fmt` | Lint, format |

---

## Deployment

Both apps run on a single **DigitalOcean droplet**, with the database on **Turso**. Deploys are manual
(no CI/CD): SSH into the droplet and run the deploy script.

| Piece | How it runs | URL |
| :--- | :--- | :--- |
| Webapp | Static Astro build in `/var/www/expenser`, served by nginx | `https://expenser.juanromerodev.com` |
| Backend | Rust release binary under **pm2** on `127.0.0.1:3001`, reverse-proxied by nginx | `https://expenser-api.juanromerodev.com` |
| Database | Turso DB `expenser` (libSQL) | — |

Everything lives in [`deploy/`](deploy):

- [`deploy/deploy.sh`](deploy/deploy.sh) pulls, installs, builds both apps, `rsync`s the webapp to the web root, and restarts the backend under pm2
- [`deploy/ecosystem.config.cjs`](deploy/ecosystem.config.cjs) is the pm2 process definition (the binary loads `apps/backend/.env` itself)
- [`deploy/nginx/`](deploy/nginx) has one server block per domain

### One-time droplet setup

```sh
# System packages (Ubuntu)
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx rsync git build-essential
# Node 22+ (e.g. via nvm or NodeSource), then pnpm + pm2
corepack enable && corepack prepare pnpm@10 --activate
npm install -g pm2
# Rust, to build the backend
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

# With 1 GB of RAM, add swap: compiling the backend peaks around 0.5 GB per compiler process
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

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

The first build compiles every dependency and takes a few minutes; later ones only recompile the
backend itself. Database migrations are applied when the backend starts.

To change backend env vars, edit `apps/backend/.env` and run `pm2 restart expenser-backend` (the
binary reads the file at startup). Changing `apps/webapp/.env` requires a redeploy, because the
values are baked into the build. Logs: `pm2 logs expenser-backend`.

### Switching from the Node backend (one-time)

`pnpm run deploy` runs the deploy script from the current checkout, and the old one can't move pm2
over to the Rust binary. So for the first deploy of the Rust backend, install Rust (see the setup
above) and pull before deploying:

```sh
cd ~/expenser && git pull --ff-only && pnpm run deploy
```

The production `.env` needs no changes, and the database is adopted as it is. Afterwards
`apps/backend/dist/` and `apps/backend/node_modules/` can be deleted.

### Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Health check (no DB access) |
