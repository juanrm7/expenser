# Expenser Web App

A weekly/monthly expense tracker for managing personal budgets in Argentine Pesos (ARS), with
per-user accounts. Full-stack TypeScript monorepo.

## Monorepo Structure

**Package manager:** pnpm >= 10 | **Orchestration:** Turborepo | **Node:** >= 22.12.0

```
expenser/
├── apps/
│   ├── backend/    # Fastify REST API + Prisma + SQLite (libSQL/Turso adapter)
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
| `pnpm --filter @expenser/backend db:generate` | Generate Prisma Client |
| `pnpm --filter @expenser/backend db:migrate` | Run DB migrations (local dev) |
| `pnpm --filter @expenser/backend dev` | Backend only (`http://localhost:3001`) |
| `pnpm --filter @expenser/webapp dev` | Webapp only (`http://localhost:4321`) |

---

## Backend (`apps/backend`)

**Stack:** Fastify 5, Prisma 6 (libSQL driver adapter), SQLite/Turso, TypeScript 5 (ESM, strict), bcrypt for password hashing

- Dev: `tsx watch src/server.ts`
- Build: `tsup` → `dist/server.js` (ESM)
- Server runs on `http://localhost:3001` (`PORT`/`HOST` env; pm2 binds `127.0.0.1` in production)

### Source structure

```
src/
├── server.ts               # Entry point
├── app.ts                  # Fastify factory: cors, cookie, correlation/logger/auth plugins, controllers
├── lib/
│   ├── env.ts               # process.env reads, centralized (port, webappUrl, cookie settings, databaseUrl)
│   ├── prisma.ts             # Prisma Client singleton, wired to the libSQL driver adapter
│   ├── prisma-errors.ts      # isNotFound(err) utility (Prisma P2025)
│   ├── auth-plugin.ts        # Decorates req.user from the session cookie; exports requireAuth preHandler
│   ├── correlation-plugin.ts # Reads/generates x-correlation-id, echoes it on the response
│   └── logger-plugin.ts      # Colored one-line request log; dumps full request/error context on 5xx
└── modules/
    ├── health/
    ├── auth/          # signup/login/logout/me, session cookie issuance
    ├── categories/    # per-user categories
    └── expenses/      # per-user expenses + weekly/monthly summary
```

### Module pattern

Each feature module has three files:

- **`*.controller.ts`** — registers routes on `FastifyInstance`, handles HTTP in/out, delegates to service
- **`*.service.ts`** — exported class, contains business logic and Prisma queries
- **`*.types.ts`** — domain interfaces and request/response body types

```typescript
// Controller — non-auth modules add requireAuth as a module-wide preHandler hook
export async function categoriesController(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)
  app.get('/categories', async (req) => service.getAll(req.user!.id))
  app.post<{ Body: CreateCategoryBody }>('/categories', async (req, reply) => {
    const category = await service.create(req.user!.id, req.body)
    return reply.status(201).send(category)
  })
}

// Service — every query is scoped by userId
export class CategoriesService {
  getAll(userId: number) { return prisma.category.findMany({ where: { userId } }) }
  create(userId: number, data: CreateCategoryBody) {
    return prisma.category.create({ data: { ...data, userId } })
  }
}
```

- Controllers return `404` via `reply.status(404).send({ message: '...' })`
- Use `isNotFound(err)` from `lib/prisma-errors.ts` to detect Prisma P2025 errors
- All imports use `.js` extension (ESM requirement)
- Register new controllers in `app.ts` with `app.register(myController)`
- New modules that store user data should add `app.addHook('preHandler', requireAuth)` and scope
  every Prisma query by `req.user!.id`

### Authentication

Session-based auth using an httpOnly cookie (`session_id`), not JWTs.

- `auth-plugin.ts` runs on every request: reads the cookie, loads the session + user from the DB,
  and sets `req.user` (`SessionUser | null`). Nothing is auto-rejected — routes opt in via `requireAuth`.
- `requireAuth` (exported from `lib/auth-plugin.ts`) is a `preHandler` that 401s if `req.user` is null.
  Every module except `health` and the `signup`/`login` routes uses it.
- Sessions live in the `Session` table (30-day expiry), created on signup/login, deleted on logout
  or lazily on expiry check.
- Passwords are hashed with bcrypt (cost 10). Signup validates name/email/password/allowance and
  seeds 5 starter categories (Food, Transport, Entertainment, Bills, Other) for the new user.
- Cookie flags (`SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`) come from `lib/env.ts` — set
  `secure=true` and `sameSite=none` when the API and webapp are on different origins in production.
- `AuthError` (with an HTTP `status`) is the module's error type; controllers catch it and forward
  the status/message, otherwise rethrow.

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
| GET | `/categories/:id` | required | Single category |
| POST | `/categories` | required | Create category |
| PATCH | `/categories/:id` | required | Update category |
| DELETE | `/categories/:id` | required | Delete category (204) |
| GET | `/expenses` | required | List all expenses for the current user |
| GET | `/expenses/summary` | required | Weekly + monthly summary (allowance, spent, available, expenses) |
| GET | `/expenses/:id` | required | Single expense |
| POST | `/expenses` | required | Create expense (body: `{ amount, description, categoryId }`) |
| PATCH | `/expenses/:id` | required | Update expense |
| DELETE | `/expenses/:id` | required | Delete expense (204) |

**Weekly/monthly summary (`ExpensesService.getWeeklySummary`):**
- The week "starts" on the most recent **Saturday** (see `getCurrentWeekStart` in
  `expenses.service.ts`) — not Monday.
- The allowance is **per-user**: `User.expendableAmountPerWeek`, set at signup and editable via
  `PATCH /auth/me`. There is no hardcoded global allowance.
- The response also includes a `monthly` block (calendar month to date): allowance is derived as
  `(weekly allowance / 7) * daysInMonth`, spent is aggregated from expenses in the current month.

### Environment (`.env`, see `.env.example`)

```
DATABASE_URL="file:./dev.db"        # Prisma CLI (migrate/generate)
TURSO_DATABASE_URL="file:./prisma/dev.db"  # Runtime connection (libSQL adapter); libsql://... in prod
TURSO_AUTH_TOKEN=                   # Required only for remote (libsql://) databases
PORT=3001
HOST=0.0.0.0                        # pm2 sets 127.0.0.1 in production (behind nginx)
WEBAPP_URL=http://localhost:4321    # Allowed CORS origin
SESSION_COOKIE_SECURE=false         # true in production (HTTPS-only cookies)
SESSION_COOKIE_SAMESITE=lax         # lax in prod too (expenser.* + expenser-api.* are same-site)
```

`lib/prisma.ts` always goes through the `@prisma/adapter-libsql` driver adapter — locally it points
at the same SQLite file the Prisma CLI uses; in production it points at a Turso `libsql://` URL.

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
│   └── categories.ts        # getCategories, createCategory, deleteCategory
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

- `deploy/deploy.sh` runs on the droplet: `git pull`, `pnpm install`, builds the backend (tsup) and
  webapp (astro) per-package (not via turbo, whose cache doesn't see the gitignored `.env` files),
  `rsync`s `apps/webapp/dist/` to `/var/www/expenser`, then `pm2 startOrReload` + `pm2 save`.
- `deploy/ecosystem.config.cjs`: pm2 app `expenser-backend` runs `apps/backend/dist/server.js`
  with `node --env-file=.env` (reads `apps/backend/.env`), `HOST=127.0.0.1`.
- `deploy/nginx/expenser.conf` serves the static site (`/_astro/` immutable, everything else
  `no-cache` for PWA updates). `deploy/nginx/expenser-api.conf` proxies
  `expenser-api.juanromerodev.com` → `127.0.0.1:3001`. TLS is added by `certbot --nginx`.
- Redeploy: on the droplet, `cd ~/expenser && pnpm run deploy` (not bare `pnpm deploy`, a pnpm built-in).
- Backend env vars live in `apps/backend/.env` on the droplet: edit it, then
  `pm2 reload deploy/ecosystem.config.cjs --update-env`.
- Prisma can't `migrate deploy` against a remote `libsql://` URL, so apply schema changes to Turso as
  raw SQL: `pnpm --filter @expenser/backend db:turso:sql | turso db shell expenser`.
- See README "Deployment" for the one-time droplet setup.

---

## Database Schema

```prisma
model User {
  id                      Int        @id @default(autoincrement())
  name                    String
  email                   String     @unique
  passwordHash            String
  expendableAmountPerWeek Float
  role                    String     @default("user")
  createdAt               DateTime   @default(now())
  updatedAt               DateTime   @updatedAt
  sessions                Session[]
  categories              Category[]
  expenses                Expense[]
}

model Session {
  id        String   @id
  userId    Int
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
}

model Category {
  id     Int    @id @default(autoincrement())
  name   String
  color  String
  userId Int
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Expense {
  id          Int      @id @default(autoincrement())
  description String
  amount      Float
  category    String   // Denormalized: stores name, not a FK
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  userId      Int
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Design notes:**
- `Expense.category` stores the category name as a string (no foreign key to `Category`). The
  controller resolves `categoryId` → `category.name` at write time. Deleting a category does not
  affect existing expenses.
- Every `Category`/`Expense`/`Session` row is scoped to a `User` via `userId` with cascade delete —
  deleting a user wipes their categories, expenses, and sessions.

---

## TypeScript

- **Strict mode** in both apps
- Backend: `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`
- Webapp: extends `astro/tsconfigs/strict`, `jsx: react-jsx` (no explicit React import needed)
- Use `type` imports where possible (`import type { ... }`)
