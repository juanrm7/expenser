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

**Stack:** Fastify 5, TypeScript, Prisma 6, SQLite

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
| `DATABASE_URL` | `file:./dev.db` | SQLite database path |
| `PORT` | `3000` | Port the server listens on |

### Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start dev server at `http://localhost:3000` (with watch) |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` | Run the compiled build |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:migrate` | Run database migrations |

### Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Returns `{ message: "Hello World" }` |
