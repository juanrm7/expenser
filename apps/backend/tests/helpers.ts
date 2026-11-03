// Drives the real app against a temporary database, with "now" fixed at `NOW`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { Client } from '@libsql/client'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { openDatabase, type Database } from '../src/db/index.js'
import { categories, encodeTimestamp, expenses, sessions, users } from '../src/db/schema.js'

/** The session cookie of seeded user 1, which requests use unless they pass their own headers. */
export const USER_1 = { cookie: 'session_id=session-1' }

/** A local date and time, like `2026-10-22T12:00:00`. */
export const local = (value: string) => new Date(value)

/** "Now" in every test: Thursday 2026-10-22 at noon, local time. */
export const NOW = local('2026-10-22T12:00:00')

/** An instant as the API formats it. */
export const iso = (instant: Date) => instant.toISOString()

export const config: Config = {
  host: '127.0.0.1',
  port: 0,
  apiUrl: 'https://api.example.com',
  webappUrl: 'http://localhost:4321',
  cookieSecure: false,
  cookieSameSite: 'lax',
  databaseUrl: '',
  databaseAuthToken: '',
}

export interface TestResponse {
  status: number
  headers: Record<string, string>
  /** The JSON the API answered with, or null for an empty body. */
  body: any
}

type Headers = Record<string, string | undefined>

export class TestApp {
  private constructor(
    readonly app: ReturnType<typeof buildApp>,
    readonly db: Database,
    readonly client: Client,
  ) {}

  /** A fresh app and database, torn down when the test ends. */
  static async spawn(t: TestContext): Promise<TestApp> {
    const dir = await mkdtemp(join(tmpdir(), 'expenser-test-'))
    const { client, db } = await openDatabase(join(dir, 'test.db'))
    const app = buildApp({ db, config, now: () => NOW }, { requestLog: false })
    t.after(async () => {
      await app.close()
      client.close()
      await rm(dir, { recursive: true, force: true })
    })
    return new TestApp(app, db, client)
  }

  /**
   * Users 1 and 2, with sessions `session-1` and `session-2`; categories 1–2 belong to user 1 and
   * category 3 to user 2.
   */
  async seedUsers(): Promise<void> {
    for (const id of [1, 2]) {
      await this.db.insert(users).values({
        id,
        name: `User ${id}`,
        email: `user${id}@example.com`,
        passwordHash: 'test',
        expendableAmountPerWeek: 1000,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await this.db
        .insert(sessions)
        .values({ id: `session-${id}`, userId: id, expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) })
    }
    await this.db.insert(categories).values([
      { id: 1, name: 'Food', color: '#10b981', userId: 1 },
      { id: 2, name: 'Transport', color: '#3b82f6', userId: 1 },
      { id: 3, name: 'Other user', color: '#3b82f6', userId: 2 },
    ])
  }

  /** Inserts an expense at a local date and time, returning its id. */
  async seedExpense(at: string, amount: number, userId: number): Promise<number> {
    const [expense] = await this.db
      .insert(expenses)
      .values({ description: 'Existing expense', amount, category: 'Food', createdAt: local(at), updatedAt: local(at), userId })
      .returning({ id: expenses.id })
    return expense!.id
  }

  /** Runs raw SQL, for setting up states the API can't reach (timestamps bound as stored). */
  async execute(sql: string, args: (string | number | Date)[] = []): Promise<void> {
    await this.client.execute({ sql, args: args.map((arg) => (arg instanceof Date ? encodeTimestamp(arg) : arg)) })
  }

  get(url: string) {
    return this.request('GET', url, undefined, USER_1)
  }

  post(url: string, body: unknown) {
    return this.request('POST', url, body, USER_1)
  }

  patch(url: string, body: unknown) {
    return this.request('PATCH', url, body, USER_1)
  }

  delete(url: string) {
    return this.request('DELETE', url, undefined, USER_1)
  }

  async request(method: string, url: string, body?: unknown, headers: Headers = {}): Promise<TestResponse> {
    const json = body === undefined ? {} : { 'content-type': 'application/json' }
    return this.send({
      method,
      url,
      headers: { ...json, ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** POSTs an `application/x-www-form-urlencoded` body, as OAuth clients do. */
  postForm(url: string, form: Record<string, string>): Promise<TestResponse> {
    return this.send({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    })
  }

  async send(options: { method: string; url: string; headers: Headers; payload?: string }) {
    const headers = Object.entries(options.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const response = await this.app.inject({
      ...options,
      method: options.method as 'GET',
      headers: Object.fromEntries(headers),
    })
    const responseHeaders = Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
    )
    return {
      status: response.statusCode,
      headers: responseHeaders,
      body: response.body ? JSON.parse(response.body) : null,
    }
  }
}

/** The values of one field of a list of objects. */
export function pluck(items: Record<string, unknown>[], field: string): unknown[] {
  return items.map((item) => item[field])
}
