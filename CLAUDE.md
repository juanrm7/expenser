# Expenser Web App

A weekly/monthly expense tracker for managing personal budgets in Argentine Pesos (ARS), with
per-user accounts. Monorepo with a TypeScript webapp and a Rust backend.

## Monorepo Structure

**Package manager:** pnpm >= 10 | **Orchestration:** Turborepo | **Node:** >= 22.12.0 | **Rust:** stable (rustup)

```
expenser/
├── apps/
│   ├── backend/    # Rust REST API: axum + libSQL (SQLite file locally, Turso in production)
│   └── webapp/     # Astro + React + Tailwind CSS (installable PWA)
├── deploy/         # Droplet deploy: deploy.sh, pm2 ecosystem.config.cjs, nginx/ server blocks
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Common commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start both apps in dev mode |
| `pnpm build` | Build both apps for production |
| `pnpm --filter @expenser/backend test` | Run backend tests (`cargo test` in `apps/backend`) |
| `pnpm --filter @expenser/backend dev` | Backend only (`http://localhost:3001`) |
| `pnpm --filter @expenser/webapp dev` | Webapp only (`http://localhost:4321`) |

---

## Backend (`apps/backend`)

**Stack:** Rust (edition 2024), axum 0.8 + tokio, tower-http (CORS, request ids, tracing), libSQL
(`libsql` crate: a local SQLite file or remote Turso), serde, chrono, bcrypt, tracing, rmcp (MCP
server) + schemars

- Dev: `cargo run` (what `pnpm dev` runs)
- Build: `cargo build --release` → `target/release/expenser-backend`
- Server runs on `http://localhost:3001` (`PORT`/`HOST` env; pm2 binds `127.0.0.1` in production)
- Before committing: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test`

### Source structure

```
migrations/
└── 0001_init.sql  # Schema migrations, embedded in the binary and applied in order at startup
src/
├── main.rs        # Entry point: loads .env (dotenvy), tracing, config, db, serve + graceful shutdown
├── lib.rs         # AppState { db, config, clock }; app(): routes + middleware (request id, trace, CORS)
├── config.rs      # Config::from_env(): every env read, validated at startup
├── db.rs          # open() (connect + migrate), MIGRATIONS, fetch_all/fetch_optional/fetch_one/fetch_value,
│                  # timestamp() (DB encoding), to_json/to_json_opt (API encoding of timestamps)
├── error.rs       # AppError + Result alias; JsonBody<T> and Id extractors
├── dates.rs       # parse_date, local_date, week_start, month_start, start_of_day (server's local TZ)
├── auth.rs        # User/Role, AuthUser/SessionUser extractors, sessions, /auth/* handlers
├── api_keys.rs    # /api-keys handlers; key_user() resolves an API key to its owner
├── categories.rs  # /categories handlers; all/find/add/edit/delete (also used by expenses, mcp)
├── expenses.rs    # /expenses handlers + the weekly/monthly summary; summarize/add/edit/delete
└── mcp.rs         # /mcp: MCP server (rmcp) whose tools call the functions above
tests/
├── common/mod.rs  # TestApp: the real router over a temp DB, clock fixed, seed helpers
├── expenses.rs    # Expense + summary regression tests
├── api.rs         # Auth, sessions, categories, API keys, HTTP plumbing, migrations
└── mcp.rs         # MCP auth, handshake and every tool
```

### Feature pattern

Each feature is one file: its row/body types, a `routes()` function, the handlers and their SQL.

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")] // JSON fields and DB columns are both camelCase
pub struct Category { pub id: i64, pub name: String, pub color: String, pub user_id: i64 }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/categories", get(list).post(create))
        .route("/categories/{id}", get(show).patch(update).delete(remove))
}

// Auth is an extractor: AuthUser = session or API key (401 otherwise), SessionUser = session only.
async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<Category>)> {
    let category = db::fetch_one(
        &state.db,
        "INSERT INTO Category (name, color, userId) VALUES (?1, ?2, ?3) RETURNING *",
        params![body.name, body.color, user.id], // every query is scoped by the user's id
    )
    .await?;
    Ok((StatusCode::CREATED, Json(category)))
}
```

- Merge a new feature's `routes()` into `app()` in `src/lib.rs`.
- When the MCP server offers an action too, its logic lives in a `pub async fn` the handler wraps
  (`expenses::add`, `categories::edit`, `auth::update_profile`, …): body in, row or `AppError`
  out. The MCP tool calls the same function, so both validate identically.
- Errors: return `AppError::bad_request` / `not_found` / `new(status, msg)`; `?` on anything else
  becomes a logged 500. Every error body is `{ "message": "..." }`, including malformed JSON
  (`JsonBody`) and non-numeric ids (`Id`, 400 `Invalid id`).
- Optional body fields are `Option<T>`; PATCH handlers use `SET col = COALESCE(?n, col)` so omitted
  fields keep their value, and `RETURNING *` to get the row back in the same round trip. "Not
  found" is a `fetch_optional` returning `None`, or an `execute` that affected 0 rows.
- Rows deserialize by column name. When joining, alias columns (`User.id AS id`) and embed a
  `User` with `#[serde(flatten)]`.
- Time: use `state.now()`, never `Utc::now()`, in handlers, so tests can fix the clock. Bind
  timestamps with `db::timestamp(t)`; serialize them with `#[serde(serialize_with = "db::to_json")]`.
- One shared `libsql::Connection` (in `AppState`) serves every request; for Turso it reuses one
  HTTP connection pool. Use `state.db.transaction()` for multi-statement writes (see signup).
- Blocking work (bcrypt) goes through `tokio::task::spawn_blocking`.

### Authentication

Session-based auth using an httpOnly cookie (`session_id`), not JWTs, plus per-user **API keys**
for scripts (`Authorization: Bearer exp_...`).

- The `AuthUser` and `SessionUser` extractors (`auth.rs`) read the `session_id` cookie and load the
  session + user; with no valid session they fall back to a Bearer API key. Nothing is rejected
  globally: routes opt in by taking one of them as an argument.
- `AuthUser` 401s without a user and accepts both auth methods. Every route except `/health`,
  signup, login, the `api-keys` routes and `/mcp` takes it.
- `/mcp` accepts API keys only (`auth::api_key_user`), never the session cookie, so a web page
  can't drive it through a logged-in browser. It 401s with `WWW-Authenticate: Bearer`.
- `SessionUser` additionally 403s API-key requests. The `api-keys` routes use it, so a leaked key
  can't create or revoke keys.
- API keys: `exp_` + 32 random bytes (base64url). Only a SHA-256 hash (`keyHash`, unique, used for
  lookup) and a display `prefix` are stored; the full key is returned once by `POST /api-keys`.
  Revoking deletes the row. `lastUsedAt` is updated at most once a minute per key. Max 10 per user.
- Sessions live in the `Session` table (30-day expiry, cookie `Max-Age` to match), created on
  signup/login, deleted on logout or lazily when an expired one is used.
- Passwords are hashed with bcrypt (cost 10, `$2b$`, compatible with the previous Node backend's
  hashes). Signup validates name/email/password/allowance and seeds 5 starter categories (Food,
  Transport, Entertainment, Bills, Other) for the new user in the same transaction.
- Cookie flags (`SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`) come from `Config` — set
  `secure=true` and `sameSite=none` when the API and webapp are on different origins in production.

### API routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Health check |
| POST | `/auth/signup` | — | Create account, seed starter categories, start session |
| POST | `/auth/login` | — | Start session |
| POST | `/auth/logout` | required | Destroy session |
| GET | `/auth/me` | required | Current user |
| PATCH | `/auth/me` | required | Update name / `expendableAmountPerWeek` |
| GET | `/categories` | required | List categories for the current user |
| GET | `/categories/{id}` | required | Single category |
| POST | `/categories` | required | Create category |
| PATCH | `/categories/{id}` | required | Update category |
| DELETE | `/categories/{id}` | required | Delete category (204) |
| GET | `/expenses` | required | List all expenses for the current user |
| GET | `/expenses/summary` | required | Weekly + current-month summary; optional `?weekStart=YYYY-MM-DD` selects a previous Saturday |
| GET | `/expenses/{id}` | required | Single expense |
| POST | `/expenses` | required | Create expense (body: `{ amount, description, categoryId, date? }`, date is `YYYY-MM-DD`) |
| PATCH | `/expenses/{id}` | required | Update expense |
| DELETE | `/expenses/{id}` | required | Delete expense (204) |
| GET | `/api-keys` | session only | List the user's API keys (name, prefix, lastUsedAt, createdAt) |
| POST | `/api-keys` | session only | Create a key (body: `{ name }`); response includes the full `key`, shown once |
| DELETE | `/api-keys/{id}` | session only | Revoke a key (204) |
| POST | `/mcp` | API key only | MCP server for AI assistants (see below) |

"Required" accepts a session cookie or an API key; "session only" rejects API keys with 403.

**Weekly/monthly summary (`summary` in `expenses.rs`):**
- Weeks run **Saturday through Friday** (see `week_start` in `dates.rs`), in the server's local
  time zone (`TZ`).
  Optional `weekStart` selects a previous Saturday; future weeks are rejected. Responses include
  `currentWeekStart` and `today`; summary expenses include a calendar `date` for consistent editing
  across browser/server time zones. Queries are bounded by both ends of the selected week.
- The home screen supports previous/next-week navigation and adding, editing or deleting expenses
  in the selected week. Optional `date` on POST/PATCH sets `createdAt` (the existing expense date);
  omitting it preserves the current-time default on creation and the original date on updates.
  Dates must be valid calendar dates on or before today. Saved categories can be kept even if deleted.
- The allowance is **per-user**: `User.expendableAmountPerWeek`, set at signup and editable via
  `PATCH /auth/me`. There is no hardcoded global allowance.
- The response also includes a `monthly` block (calendar month to date): allowance is derived as
  `(weekly allowance / 7) * daysInMonth`, spent is aggregated from expenses in the current month.

### MCP server (`mcp.rs`)

`/mcp` lets AI assistants (Claude Code: `claude mcp add --transport http expenser <api>/mcp
--header "Authorization: Bearer exp_..."`) use the app through tools: `get_summary`,
`list_expenses`, `add_expense`/`update_expense`/`delete_expense`, `list_categories`/`add_category`/
`update_category`/`delete_category`, `get_profile`/`update_profile`.

- Built on `rmcp`'s Streamable HTTP service, stateless (no MCP sessions, `NeverSessionManager`) with
  JSON responses. `serve` authenticates the API key, then hands the request to a fresh service whose
  `Server` holds `AppState` and that `User`, so tools act as the key's owner.
- A tool is a method in the `#[tool_router] impl Server` block: its doc comment is the description,
  its `Parameters<Args>` struct (serde + `JsonSchema`, field doc comments) the input schema, and
  `annotations(read_only_hint = true)` / `destructive_hint = false` mark reads and pure additions.
- Tools return `reply(result)`: the value as JSON text, a client `AppError` as a tool error
  (`isError`) the model reads and can act on, an internal one as a logged JSON-RPC internal error.
- Tools take categories by name (case-insensitive) and return expenses with their local `date`.
  `list_expenses` is MCP-only: date range/category/description filters, totals over every match,
  at most `limit` expenses.
- Host checks are disabled (`disable_allowed_hosts`): they protect servers that trust whoever can
  reach them, and this one trusts only API keys. rmcp still requires a `Host` header (tests send one).
- rmcp logs every request's lifecycle at info, so `main.rs` puts `rmcp=warn` before `RUST_LOG`.

### Environment (`.env`, see `.env.example`)

```
TURSO_DATABASE_URL="file:./dev.db"  # Local SQLite file (created on first start); libsql://... in prod
TURSO_AUTH_TOKEN=                   # Required only for remote (libsql://) databases
PORT=3001
HOST=0.0.0.0                        # pm2 sets 127.0.0.1 in production (behind nginx)
WEBAPP_URL=http://localhost:4321    # Allowed CORS origin
SESSION_COOKIE_SECURE=false         # true in production (HTTPS-only cookies)
SESSION_COOKIE_SAMESITE=lax         # lax in prod too (expenser.* + expenser-api.* are same-site)
RUST_LOG=info                       # tracing filter (default info; rmcp stays at warn unless named)
```

All of them are optional locally. `main.rs` loads `apps/backend/.env` with dotenvy; variables already
set in the environment (e.g. by pm2) win. `db::open` connects through the `libsql` crate: a local
file for `file:` URLs and plain paths, remote Turso for `libsql://`.

---

## Webapp (`apps/webapp`)

**Stack:** Astro 6, React 19, Tailwind CSS 4, TypeScript (extends Astro strict config), installable PWA (`@vite-pwa/astro`)

- Dev: `astro dev` → `http://localhost:4321`
- Build: `astro build` → `dist/`

### Source structure

```
src/
├── pages/
│   ├── index.astro         # Route: / (home, requires auth client-side)
│   ├── login.astro          # Route: /login
│   ├── signup.astro         # Route: /signup
│   ├── settings.astro       # Route: /settings
│   └── 404.astro
├── layouts/
│   └── Layout.astro        # Base HTML shell; registers the PWA service worker in prod
├── components/
│   ├── Header.tsx          # Shared nav header (shows user name, settings/home toggle, logout)
│   ├── ApiKeysSection.tsx  # Settings: create (key shown once + copy), list, revoke API keys
│   └── HomeSkeleton.tsx    # HeaderSkeleton / HomeSkeleton loading placeholders
├── renderers/
│   ├── HomePage.tsx        # Fetches summary+categories once authed, owns page state
│   ├── SettingsPage.tsx
│   ├── LoginPage.tsx        # Redirects to / if already authed, else renders LoginForm
│   └── SignupPage.tsx
├── templates/
│   ├── ExpenseTracker.tsx  # Main expense UI: weekly balance card, monthly overview, form, list
│   ├── SettingsScreen.tsx  # Profile (name/allowance) + category editor
│   ├── LoginForm.tsx
│   └── SignupForm.tsx
├── services/
│   ├── auth.ts              # signup, login, logout, getCurrentUser, updateProfile
│   ├── expenses.ts          # getExpenses, getExpenseSummary, createExpense, deleteExpense
│   ├── categories.ts        # getCategories, createCategory, deleteCategory
│   └── apiKeys.ts           # getApiKeys, createApiKey, revokeApiKey
├── lib/
│   ├── apiFetch.ts           # fetch wrapper: prefixes backendUrl, adds x-correlation-id, credentials:'include', console-logs each request
│   ├── useAuth.ts            # React hook: shows cached user immediately, revalidates via /auth/me, redirects to /login if unauthenticated
│   ├── cache.ts              # localStorage cache of the current user, used by useAuth for instant paint
│   └── data.ts               # formatARS(), randomHexColor()/HEX_COLOR_PALETTE (still used); the
│                              # rest of this file (loadConfig/saveConfig/loadWeekData/getMondayOf/
│                              # BASE_ALLOWANCE/DEFAULT_CATEGORIES) is unused legacy local-storage
│                              # code from before the backend existed — don't build on it
├── config/
│   └── environment.ts      # Exports env.backendUrl
└── styles/
    └── global.css          # @import "tailwindcss"
```

### Component hierarchy

```
Astro page (.astro)
  └── Renderer (client:load React) — fetches data, manages state
        └── Template — receives data as props, handles UI + form submission
              └── Components (Header, HomeSkeleton, etc.)
```

Astro pages hydrate renderers with `client:load`:
```astro
<Layout title="Expenser">
  <HomePage client:load />
</Layout>
```

### Auth flow

- No route guarding at the Astro/SSG level (the site is static) — each protected renderer uses
  `useAuth()` (or an inline `getCurrentUser()` check on `/login` and `/signup`) and redirects via
  `window.location.href`.
- `useAuth()` paints the last-known user from `localStorage` (via `cache.ts`) immediately, then
  calls `GET /auth/me` to revalidate. On a confirmed 401 it clears the cache and redirects to
  `/login`; on a network error it keeps showing the cached user if there is one.
- `Header`'s logout button calls `POST /auth/logout`, clears the cache, and redirects to `/login`.

### Service layer

All API calls live in `src/services/` and go through `apiFetch` (`src/lib/apiFetch.ts`), which
prefixes `env.backendUrl`, always sends `credentials: 'include'` (needed for the session cookie),
attaches a generated `x-correlation-id` header, and logs each request/response to the console.

```typescript
// expenses.ts
export async function createExpense(payload: {
  amount: number
  description: string
  categoryId: number
}): Promise<Expense>

export async function deleteExpense(id: number): Promise<void>
export async function getExpenseSummary(): Promise<ExpenseSummary> // includes `monthly` block
```

### Styling

- Tailwind CSS 4 utility classes only — no custom CSS unless unavoidable
- All colors, spacing, and layout via Tailwind
- Inline `style` prop only for dynamic values (e.g. category colors from DB)

### Environment (`.env`)

```
PUBLIC_BACKEND_URL=http://localhost:3001
```

Accessed via `import.meta.env.PUBLIC_BACKEND_URL` (Astro public variable convention).

### Deployment

Static build `rsync`ed to `/var/www/expenser` on the droplet and served by nginx
(`deploy/nginx/expenser.conf`) at `expenser.juanromerodev.com`. `PUBLIC_BACKEND_URL` comes from
`apps/webapp/.env` on the droplet and is baked in at build time. See "Deployment" below.

---

## Deployment

Both apps run on a single **DigitalOcean droplet**; the database is on **Turso** (hosted libSQL).
Manual deploys only, no CI/CD. Everything lives in `deploy/`:

- `deploy/deploy.sh` runs on the droplet: `git pull`, `pnpm install`, builds the backend
  (`cargo build --release` via its package script) and webapp (astro) per-package (not via turbo,
  whose cache doesn't see the gitignored `.env` files), `rsync`s `apps/webapp/dist/` to
  `/var/www/expenser`, then `pm2 delete` + `pm2 start` (so pm2 config changes always apply) +
  `pm2 save`. It puts `~/.cargo/bin` on `PATH` and stops early if cargo is missing.
- `deploy/ecosystem.config.cjs`: pm2 app `expenser-backend` runs
  `apps/backend/target/release/expenser-backend` (`interpreter: 'none'`), which reads
  `apps/backend/.env` itself; `HOST=127.0.0.1`.
- `deploy/nginx/expenser.conf` serves the static site (`/_astro/` immutable, everything else
  `no-cache` for PWA updates). `deploy/nginx/expenser-api.conf` proxies
  `expenser-api.juanromerodev.com` → `127.0.0.1:3001`. TLS is added by `certbot --nginx`.
- Redeploy: on the droplet, `cd ~/expenser && pnpm run deploy` (not bare `pnpm deploy`, a pnpm built-in).
- Backend env vars live in `apps/backend/.env` on the droplet: edit it, then
  `pm2 restart expenser-backend`.
- Schema changes: add `apps/backend/migrations/000N_<name>.sql` and list it in `MIGRATIONS`
  (`src/db.rs`). The backend applies pending migrations at startup, locally and on Turso alike,
  and records them in `_migrations`. Never edit a migration that has been applied.
- See README "Deployment" for the one-time droplet setup (including Rust and swap).

---

## Database Schema

Source of truth: `apps/backend/migrations/` (`0001_init.sql` is the schema the previous Prisma
backend created; quoted camelCase identifiers).

```
User     (id PK, name, email UNIQUE, passwordHash, expendableAmountPerWeek REAL,
          role DEFAULT 'user', createdAt, updatedAt)
Session  (id TEXT PK, userId → User, expiresAt, createdAt)
Category (id PK, name, color, userId → User)
Expense  (id PK, description, amount REAL, category TEXT, createdAt, updatedAt, userId → User)
ApiKey   (id PK, name, prefix, keyHash UNIQUE, lastUsedAt NULL, createdAt, userId → User)
```

**Design notes:**
- Timestamps are UTC `TEXT` in a fixed-width format, `2026-10-12T03:00:00.000+00:00` (what Prisma
  wrote), so range queries compare them as strings: always write them with `db::timestamp()`. The
  API returns them as `2026-10-12T03:00:00.000Z`.
- `Expense.category` stores the category name as a string (no foreign key to `Category`). The
  handler resolves `categoryId` → `category.name` at write time. Deleting a category does not
  affect existing expenses.
- `Expense.createdAt` is when the expense happened: now by default, or the start of the local day
  given as `date`.
- Every `Category`/`Expense`/`Session`/`ApiKey` row is scoped to a `User` via `userId` with
  `ON DELETE CASCADE`.

---

## Conventions

- **Rust (backend):** edition 2024, default `rustfmt`, clippy clean with `-D warnings`. `anyhow`
  (with `.context(...)`) for internal errors, `AppError` at the HTTP boundary; no `unwrap()` in
  request paths. Integration tests go in `tests/`, unit tests in a `#[cfg(test)] mod tests` beside
  the code.
- **TypeScript (webapp):** strict mode, extends `astro/tsconfigs/strict`, `jsx: react-jsx` (no
  explicit React import needed). Use `type` imports where possible (`import type { ... }`).
