# Expenser Web App

A weekly expense tracker for managing personal budgets in Argentine Pesos (ARS). Full-stack TypeScript monorepo.

## Monorepo Structure

**Package manager:** pnpm >= 10 | **Orchestration:** Turborepo | **Node:** >= 22.12.0

```
expenser/
├── apps/
│   ├── backend/    # Fastify REST API + Prisma + SQLite
│   └── webapp/     # Astro + React + Tailwind CSS
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Common commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start both apps in dev mode |
| `pnpm build` | Build both apps for production |
| `pnpm db:generate` | Generate Prisma Client |
| `pnpm --filter @expenser/backend db:migrate` | Run DB migrations |
| `pnpm --filter @expenser/backend dev` | Backend only |
| `pnpm --filter @expenser/webapp dev` | Webapp only |

---

## Backend (`apps/backend`)

**Stack:** Fastify 5, Prisma 6, SQLite, TypeScript 5 (ESM, strict)

- Dev: `tsx watch src/server.ts`
- Build: `tsup` → `dist/server.js` (ESM)
- Server runs on `http://localhost:3001`

### Source structure

```
src/
├── server.ts               # Entry point
├── app.ts                  # Fastify factory, registers CORS + controllers
├── lib/
│   ├── prisma.ts           # Prisma Client singleton
│   └── prisma-errors.ts    # isNotFound(err) utility
└── modules/
    ├── health/
    ├── categories/
    └── expenses/
```

### Module pattern

Each feature module has three files:

- **`*.controller.ts`** — registers routes on `FastifyInstance`, handles HTTP in/out, delegates to service
- **`*.service.ts`** — exported class, contains business logic and Prisma queries
- **`*.types.ts`** — domain interfaces and request/response body types

```typescript
// Controller
export async function categoriesController(app: FastifyInstance) {
  app.get('/categories', async () => service.getAll())
  app.post<{ Body: CreateCategoryRequest }>('/categories', async (req, reply) => {
    const category = await service.create(req.body)
    return reply.status(201).send(category)
  })
}

// Service
export class CategoriesService {
  getAll() { return prisma.category.findMany() }
  create(data: CreateCategoryBody) { return prisma.category.create({ data }) }
}
```

- Controllers return `404` via `reply.status(404).send({ message: '...' })`
- Use `isNotFound(err)` from `lib/prisma-errors.ts` to detect Prisma P2025 errors
- All imports use `.js` extension (ESM requirement)
- Register new controllers in `app.ts` with `app.register(myController)`

### API routes

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/categories` | List all categories |
| POST | `/categories` | Create category |
| PATCH | `/categories/:id` | Update category |
| DELETE | `/categories/:id` | Delete category (204) |
| GET | `/expenses` | List all expenses |
| GET | `/expenses/summary` | Weekly summary (allowance, spent, available, expenses) |
| GET | `/expenses/:id` | Single expense |
| POST | `/expenses` | Create expense (body: `{ amount, description, categoryId }`) |
| PATCH | `/expenses/:id` | Update expense |
| DELETE | `/expenses/:id` | Delete expense (204) |

**Weekly summary:** week starts Monday, base allowance is 100,000 ARS (hardcoded in `ExpensesService`).

### Environment (`.env`)

```
DATABASE_URL="file:./dev.db"
PORT=3001
```

---

## Webapp (`apps/webapp`)

**Stack:** Astro 6, React 19, Tailwind CSS 4, TypeScript (extends Astro strict config)

- Dev: `astro dev` → `http://localhost:4321`
- Build: `astro build` → `dist/`

### Source structure

```
src/
├── pages/
│   ├── index.astro         # Route: /
│   └── settings.astro      # Route: /settings
├── layouts/
│   └── Layout.astro        # Base HTML shell
├── components/
│   └── Header.tsx          # Shared nav header
├── renderers/
│   ├── HomePage.tsx        # Fetches data, owns page state
│   └── SettingsPage.tsx
├── templates/
│   ├── ExpenseTracker.tsx  # Main expense UI + form
│   └── SettingsScreen.tsx  # Settings UI
├── services/
│   ├── expenses.ts         # API calls: getExpenseSummary, createExpense, deleteExpense
│   └── categories.ts       # API calls: getCategories, createCategory, deleteCategory
├── config/
│   └── environment.ts      # Exports env.backendUrl
├── lib/
│   └── data.ts             # formatARS(), localStorage helpers, local types
└── styles/
    └── global.css          # @import "tailwindcss"
```

### Component hierarchy

```
Astro page (.astro)
  └── Renderer (client:load React) — fetches data, manages state
        └── Template — receives data as props, handles UI + form submission
              └── Components (Header, etc.)
```

Astro pages hydrate renderers with `client:load`:
```astro
<Layout title="Expenser">
  <HomePage client:load />
</Layout>
```

### Service layer

All API calls live in `src/services/`. They use `env.backendUrl` as the base URL and throw on non-ok responses.

```typescript
// expenses.ts
export async function createExpense(payload: {
  amount: number
  description: string
  categoryId: number
}): Promise<Expense>

export async function deleteExpense(id: number): Promise<void>
export async function getExpenseSummary(): Promise<ExpenseSummary>
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

Static build served from a **Cloud Storage bucket behind an HTTPS Load Balancer with Cloud CDN**
(project `juan-custom-apps`, domain `expenser.juanromerodev.com`). Config in
`apps/webapp/.env.deploy`. One-time infra: `apps/webapp/infra/setup-cdn.sh`. Redeploy:
`pnpm --filter @expenser/webapp run deploy` (runs `apps/webapp/deploy.sh` — build, `rsync` to bucket,
set cache headers, invalidate CDN). The app is multi-page SSG; the bucket uses
`MainPageSuffix=index.html` and a `404.html` error page. See README "Frontend deployment".

---

## Database Schema

```prisma
model Category {
  id    Int    @id @default(autoincrement())
  name  String
  color String
}

model Expense {
  id          Int      @id @default(autoincrement())
  description String
  amount      Float
  category    String   // Denormalized: stores name, not a FK
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**Design note:** `Expense.category` stores the category name as a string (no foreign key). The controller resolves `categoryId` → `category.name` at write time. This means deleting a category does not affect existing expenses.

---

## TypeScript

- **Strict mode** in both apps
- Backend: `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`
- Webapp: extends `astro/tsconfigs/strict`, `jsx: react-jsx` (no explicit React import needed)
- Use `type` imports where possible (`import type { ... }`)
