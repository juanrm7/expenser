// Accounts, sessions, categories, API keys, and HTTP plumbing.

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { encodeTimestamp } from '../src/db/schema.js'
import { iso, NOW, TestApp, USER_1 } from './helpers.js'

async function setup(t: TestContext) {
  const app = await TestApp.spawn(t)
  await app.seedUsers()
  return app
}

async function signup(app: TestApp, email: string) {
  const body = { name: ' Ana ', email, password: 'password1', expendableAmountPerWeek: 1000 }
  const response = await app.request('POST', '/auth/signup', body)
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return { user: response.body, cookie: response.headers['set-cookie']!.split(';')[0]! }
}

test('signup creates an account with starter categories and a session', async (t) => {
  const app = await TestApp.spawn(t)
  const { user, cookie } = await signup(app, '  Ana@Example.com ')
  assert.deepEqual(user, { id: 1, name: 'Ana', email: 'ana@example.com', expendableAmountPerWeek: 1000, role: 'user' })

  const categories = (await app.request('GET', '/categories', undefined, { cookie })).body
  assert.deepEqual(
    categories.map((category: { name: string }) => category.name),
    ['Food', 'Transport', 'Entertainment', 'Bills', 'Other'],
  )
  assert.deepEqual(categories[0], { id: 1, name: 'Food', color: '#f97316', userId: 1 })

  const duplicate = { name: 'Ana', email: 'ANA@example.com', password: 'password1', expendableAmountPerWeek: 1 }
  const response = await app.request('POST', '/auth/signup', duplicate)
  assert.equal(response.status, 409)
  assert.equal(response.body.message, 'Email already in use')
})

test('signup validates its fields', async (t) => {
  const app = await TestApp.spawn(t)
  const valid = { name: 'Ana', email: 'ana@example.com', password: 'password1', expendableAmountPerWeek: 0 }
  for (const [change, message] of [
    [{ name: '  ' }, 'Name is required'],
    [{ email: 'ana@example' }, 'Invalid email'],
    [{ password: 'short' }, 'Password must be at least 8 characters'],
    [{ expendableAmountPerWeek: -1 }, 'Invalid expendable amount'],
    [{ expendableAmountPerWeek: null }, 'Invalid expendable amount'],
  ] as const) {
    const response = await app.request('POST', '/auth/signup', { ...valid, ...change })
    assert.equal(response.status, 400, JSON.stringify(change))
    assert.equal(response.body.message, message)
  }
})

test('sessions log in, update the profile and log out', async (t) => {
  const app = await TestApp.spawn(t)
  const { cookie: signupCookie } = await signup(app, 'ana@example.com')

  const wrong = await app.request('POST', '/auth/login', { email: 'ana@example.com', password: 'wrong-password' })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.body.message, 'Invalid credentials')
  assert.equal((await app.request('POST', '/auth/login', { email: 'ana@example.com' })).status, 400)

  const response = await app.request('POST', '/auth/login', { email: ' ANA@example.com', password: 'password1' })
  assert.equal(response.status, 200)
  assert.equal(response.body.email, 'ana@example.com')
  const setCookie = response.headers['set-cookie']!
  for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) {
    assert.ok(setCookie.includes(attribute), `${setCookie} lacks ${attribute}`)
  }
  assert.ok(!setCookie.includes('Secure'))
  const cookie = setCookie.split(';')[0]!
  assert.notEqual(cookie, signupCookie)

  const auth = { cookie }
  const updated = await app.request('PATCH', '/auth/me', { name: ' Ana María ', expendableAmountPerWeek: 1500.5 }, auth)
  assert.equal(updated.status, 200)
  assert.equal(updated.body.name, 'Ana María')
  assert.equal(updated.body.expendableAmountPerWeek, 1500.5)
  const onlyName = await app.request('PATCH', '/auth/me', { name: 'Ana' }, auth)
  assert.equal(onlyName.body.expendableAmountPerWeek, 1500.5)
  assert.equal((await app.request('PATCH', '/auth/me', { name: ' ' }, auth)).status, 400)
  assert.equal((await app.request('PATCH', '/auth/me', { expendableAmountPerWeek: -5 }, auth)).status, 400)
  assert.equal((await app.request('GET', '/auth/me', undefined, auth)).body.name, 'Ana')

  const logout = await app.request('POST', '/auth/logout', undefined, auth)
  assert.equal(logout.status, 204)
  assert.ok(logout.headers['set-cookie']!.startsWith('session_id=;'))
  assert.ok(logout.headers['set-cookie']!.includes('Max-Age=0'))
  assert.equal((await app.request('GET', '/auth/me', undefined, auth)).status, 401)
  // Logging out ends only that session.
  assert.equal((await app.request('GET', '/auth/me', undefined, { cookie: signupCookie })).status, 200)
})

test('expired sessions are rejected and removed', async (t) => {
  const app = await setup(t)
  await app.execute(`UPDATE Session SET expiresAt = ?1 WHERE id = 'session-1'`, [new Date(NOW.getTime() - 1000)])

  assert.equal((await app.get('/auth/me')).status, 401)
  const remaining = await app.client.execute('SELECT COUNT(*) AS count FROM Session')
  assert.equal(remaining.rows[0]!.count, 1)
})

test('categories are managed per user', async (t) => {
  const app = await setup(t)

  const created = await app.post('/categories', { name: 'Pets', color: '#123456' })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body, { id: 4, name: 'Pets', color: '#123456', userId: 1 })
  assert.equal((await app.post('/categories', { name: 'No color' })).status, 400)

  const renamed = await app.patch('/categories/4', { name: 'Pet care' })
  assert.deepEqual(renamed.body, { id: 4, name: 'Pet care', color: '#123456', userId: 1 })
  assert.deepEqual((await app.patch('/categories/4', {})).body, renamed.body)
  assert.equal((await app.get('/categories/4')).body.name, 'Pet care')
  const ids = (await app.get('/categories')).body.map((category: { id: number }) => category.id)
  assert.deepEqual(ids, [1, 2, 4])

  assert.equal((await app.get('/categories/3')).status, 404)
  assert.equal((await app.patch('/categories/3', { name: 'Mine' })).status, 404)
  assert.equal((await app.patch('/categories/3', {})).status, 404)
  assert.equal((await app.delete('/categories/3')).status, 404)

  assert.equal((await app.delete('/categories/4')).status, 204)
  const gone = await app.get('/categories/4')
  assert.equal(gone.status, 404)
  assert.equal(gone.body.message, 'Category not found')
})

test('API keys authenticate scripts but cannot manage keys', async (t) => {
  const app = await setup(t)

  const created = await app.post('/api-keys', { name: ' Laptop script ' })
  assert.equal(created.status, 201)
  const key: string = created.body.key
  assert.ok(key.startsWith('exp_') && key.length === 47, key)
  assert.equal(created.body.prefix, key.slice(0, 12))
  assert.equal(created.body.name, 'Laptop script')
  assert.equal(created.body.lastUsedAt, null)
  assert.equal(created.body.createdAt, iso(NOW))
  assert.equal(created.body.keyHash, undefined)

  const auth = { authorization: `Bearer ${key}` }
  const me = await app.request('GET', '/auth/me', undefined, auth)
  assert.equal(me.status, 200)
  assert.equal(me.body.id, 1)
  const expense = { amount: 5, description: 'From a script', categoryId: 1 }
  assert.equal((await app.request('POST', '/expenses', expense, auth)).status, 201)

  const listed = (await app.get('/api-keys')).body
  assert.equal(listed.length, 1)
  assert.equal(listed[0].lastUsedAt, iso(NOW))
  assert.equal(listed[0].key, undefined)

  const forbidden = await app.request('GET', '/api-keys', undefined, auth)
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body.message, 'This action requires logging in, not an API key')
  assert.equal((await app.request('POST', '/api-keys', { name: 'x' }, auth)).status, 403)

  assert.equal((await app.request('DELETE', '/api-keys/1', undefined, { cookie: 'session_id=session-2' })).status, 404)
  assert.equal((await app.delete('/api-keys/1')).status, 204)
  assert.equal((await app.request('GET', '/auth/me', undefined, auth)).status, 401)
  assert.equal((await app.delete('/api-keys/1')).status, 404)
})

test('API key names and counts are limited', async (t) => {
  const app = await setup(t)
  assert.equal((await app.post('/api-keys', { name: '  ' })).body.message, 'Name is required')
  assert.equal((await app.post('/api-keys', { name: 'x'.repeat(51) })).body.message, 'Name must be at most 50 characters')
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.post('/api-keys', { name: `Key ${i}` })).status, 201)
  }
  const response = await app.post('/api-keys', { name: 'One too many' })
  assert.equal(response.status, 400)
  assert.equal(response.body.message, 'You can have at most 10 API keys')
})

test('API keys record their last use at most once a minute', async (t) => {
  const app = await setup(t)
  const { key } = (await app.post('/api-keys', { name: 'k' })).body
  const earlier = new Date(NOW.getTime() - 30 * 1000)
  await app.execute('UPDATE ApiKey SET lastUsedAt = ?1', [earlier])

  assert.equal((await app.request('GET', '/auth/me', undefined, { authorization: `bearer ${key}` })).status, 200)
  const lastUsed = await app.client.execute('SELECT lastUsedAt FROM ApiKey')
  assert.equal(lastUsed.rows[0]!.lastUsedAt, encodeTimestamp(earlier))

  for (const invalid of ['Bearer exp_unknown', 'Bearer ', 'Basic abc', 'exp_abc']) {
    const response = await app.request('GET', '/auth/me', undefined, { authorization: invalid })
    assert.equal(response.status, 401, invalid)
  }
})

test('a valid session takes precedence over an API key', async (t) => {
  const app = await setup(t)
  const { key } = (await app.post('/api-keys', { name: 'k' })).body
  const bearer = `Bearer ${key}`
  const both = await app.request('GET', '/auth/me', undefined, { cookie: 'session_id=session-2', authorization: bearer })
  assert.equal(both.body.id, 2)
  const staleCookie = await app.request('GET', '/auth/me', undefined, { cookie: 'session_id=gone', authorization: bearer })
  assert.equal(staleCookie.body.id, 1)
})

test('HTTP plumbing', async (t) => {
  const app = await setup(t)

  const health = await app.request('GET', '/health')
  assert.deepEqual(health.body, { message: 'Hello World' })

  const unknown = await app.request('GET', '/nope')
  assert.equal(unknown.status, 404)
  assert.deepEqual(unknown.body, { message: 'Route not found' })
  assert.deepEqual((await app.get('/expenses/abc')).body, { message: 'Invalid id' })
  assert.deepEqual((await app.get('/expenses/1.5')).body, { message: 'Invalid id' })

  const malformed = await app.request('POST', '/categories', undefined, { ...USER_1, 'content-type': 'application/json' })
  assert.equal(malformed.status, 400)
  assert.equal(typeof malformed.body.message, 'string')
  assert.deepEqual(Object.keys(malformed.body), ['message'])

  const echoed = await app.request('GET', '/health', undefined, { 'x-correlation-id': 'abc-123' })
  assert.equal(echoed.headers['x-correlation-id'], 'abc-123')
  assert.match(health.headers['x-correlation-id']!, /^[0-9a-f-]{36}$/)

  const preflight = await app.request('OPTIONS', '/expenses', undefined, {
    origin: 'http://localhost:4321',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-correlation-id',
  })
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:4321')
  assert.equal(preflight.headers['access-control-allow-credentials'], 'true')
  assert.ok(preflight.headers['access-control-allow-methods']!.includes('PATCH'))
  assert.equal(preflight.headers['access-control-allow-headers'], 'content-type,x-correlation-id')

  const cors = await app.request('GET', '/expenses', undefined, { ...USER_1, origin: 'http://localhost:4321' })
  assert.equal(cors.headers['access-control-expose-headers'], 'x-correlation-id')
})
