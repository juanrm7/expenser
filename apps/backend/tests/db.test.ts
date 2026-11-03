// Migrations, adopting the database the previous backends created, and how remote databases are used.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createClient } from '@libsql/client'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db/index.js'
import { hashToken } from '../src/lib/tokens.js'
import { config, NOW } from './helpers.js'

async function tempDatabase(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'expenser-db-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'test.db')
}

const schemaOf = async (url: string) => {
  const client = createClient({ url })
  const { rows } = await client.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE tbl_name != '__drizzle_migrations' ORDER BY name",
  )
  client.close()
  return rows.map((row) => ({ ...row }))
}

test('migrations are idempotent and recorded', async (t) => {
  const path = await tempDatabase(t)
  const first = await openDatabase(path)
  await first.client.execute(
    "INSERT INTO User (name, email, passwordHash, expendableAmountPerWeek, updatedAt) VALUES ('a', 'a@b.c', 'x', 1, 'now')",
  )
  first.client.close()

  const reopened = await openDatabase(`file:${path}`)
  const { rows } = await reopened.client.execute(
    'SELECT (SELECT COUNT(*) FROM User) AS users, (SELECT COUNT(*) FROM __drizzle_migrations) AS migrations',
  )
  reopened.client.close()
  assert.deepEqual({ ...rows[0] }, { users: 1, migrations: 1 })
})

test('a database the Rust backend migrated, like production, is adopted unchanged', async (t) => {
  const url = `file:${await tempDatabase(t)}`
  const existing = createClient({ url })
  await existing.executeMultiple(await readFile(new URL('fixtures/rust-era-schema.sql', import.meta.url), 'utf8'))
  // Rows as the Rust backend wrote them. The hash is bcrypt's of "password1".
  const later = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString().replace('Z', '+00:00')
  await existing.executeMultiple(`
    INSERT INTO User VALUES (1, 'Ana', 'ana@example.com',
      '$2b$10$jcsf8K9DaIKELwhgRj3MGur7faP4oDwDNqScdCknUFvjWIGWFUm56', 50000, 'user',
      '2026-10-01T15:00:00.000+00:00', '2026-10-01T15:00:00.000+00:00');
    INSERT INTO Session VALUES ('rust-session', 1, '${later(10)}', '2026-10-01T15:00:00.000+00:00');
    INSERT INTO Category VALUES (1, 'Food', '#f97316', 1);
    INSERT INTO Expense VALUES (1, 'Lunch', 1234.5, 'Food', '2026-10-20T03:00:00.000+00:00',
      '2026-10-20T15:00:00.000+00:00', 1);
    INSERT INTO ApiKey VALUES (1, 'Script', 'exp_rustkey1', '${hashToken('exp_rust-key')}', NULL,
      '2026-10-01T15:00:00.000+00:00', 1);
    INSERT INTO OAuthClient VALUES ('rust-client', 'Claude', '["https://claude.ai/api/mcp/auth_callback"]',
      '2026-10-01T15:00:00.000+00:00');
    INSERT INTO OAuthGrant VALUES (1, 'rust-client', 1, '${hashToken('exa_rust-token')}', '${later(1)}',
      '${hashToken('exr_rust-token')}', '${later(90)}', NULL, '2026-10-01T15:00:00.000+00:00');
  `)
  existing.close()
  const before = await schemaOf(url)

  const { client, db } = await openDatabase(url)
  t.after(() => client.close())
  assert.deepEqual(await schemaOf(url), before)
  const recorded = await client.execute('SELECT COUNT(*) AS count FROM __drizzle_migrations')
  assert.equal(recorded.rows[0]!.count, 1)

  const app = buildApp({ db, config, now: () => NOW }, { requestLog: false })
  t.after(() => app.close())
  const get = async (url: string, headers: Record<string, string>) => {
    const response = await app.inject({ url, headers })
    return { status: response.statusCode, body: response.json() }
  }
  const me = await get('/auth/me', { cookie: 'session_id=rust-session' })
  assert.deepEqual(me.body, { id: 1, name: 'Ana', email: 'ana@example.com', expendableAmountPerWeek: 50000, role: 'user' })
  assert.equal((await get('/auth/me', { authorization: 'Bearer exp_rust-key' })).body.id, 1)
  const summary = await get('/expenses/summary', { authorization: 'Bearer exp_rust-key' })
  assert.deepEqual(summary.body.expenses.map((e: { createdAt: string }) => e.createdAt), ['2026-10-20T03:00:00.000Z'])
  assert.equal(summary.body.spent, 1234.5)

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'ana@example.com', password: 'password1' },
  })
  assert.equal(login.statusCode, 200)

  const mcp = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: 'Bearer exa_rust-token',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_profile', arguments: {} } },
  })
  assert.equal(mcp.statusCode, 200, mcp.body)
  assert.equal(JSON.parse(mcp.json().result.content[0].text).email, 'ana@example.com')
  const refreshed = await app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=refresh_token&client_id=rust-client&refresh_token=exr_rust-token',
  })
  assert.equal(refreshed.statusCode, 200, refreshed.body)
})

test('outside transactions, each statement opens and closes its own remote stream', async (t) => {
  // A Turso stand-in: it answers Hrana pipelines, failing the first one as if its stream had expired.
  const pipelines: { baton?: string | null; requests: { type: string }[] }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const pipeline = JSON.parse(body)
    pipelines.push(pipeline)
    if (pipelines.length === 1) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"stream not found: expired"}')
      return
    }
    const results = pipeline.requests.map((request: { type: string }) => ({
      type: 'ok',
      response:
        request.type === 'execute'
          ? {
              type: 'execute',
              result: {
                cols: [{ name: 'one', decltype: null }],
                rows: [[{ type: 'integer', value: '1' }]],
                affected_row_count: 0,
                last_insert_rowid: null,
              },
            }
          : { type: request.type },
    }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ baton: null, base_url: null, results }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address() as { port: number }
  const client = createClient({ url: `http://127.0.0.1:${address.port}` })
  t.after(() => client.close())

  await assert.rejects(client.execute('SELECT 1 AS one'), /HTTP status 404/)
  assert.deepEqual((await client.execute('SELECT 1 AS one')).rows[0]?.one, 1)
  assert.deepEqual((await client.execute('SELECT 1 AS one')).rows[0]?.one, 1)

  assert.equal(pipelines.length, 3)
  for (const pipeline of pipelines) {
    assert.equal(pipeline.baton ?? null, null, 'reused a stream')
    assert.deepEqual(pipeline.requests.map((request) => request.type), ['execute', 'close'])
  }
})
