// The MCP server at `/mcp`: authentication, both protocol eras, and every tool.

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { TestApp, USER_1 } from './helpers.js'

const ACCEPT = { accept: 'application/json, text/event-stream' }
const PROTOCOL_VERSION = { 'mcp-protocol-version': '2025-06-18' }

/** The test app, and an `Authorization` header with an API key of user 1. */
async function setup(t: TestContext) {
  const app = await TestApp.spawn(t)
  await app.seedUsers()
  const { key } = (await app.post('/api-keys', { name: 'Claude' })).body
  return { app, auth: `Bearer ${key}` }
}

function rpc(app: TestApp, auth: string, method: string, params: unknown) {
  const body = { jsonrpc: '2.0', id: 1, method, params }
  return app.request('POST', '/mcp', body, { authorization: auth, ...ACCEPT, ...PROTOCOL_VERSION })
}

type ToolResult = { ok: true; value: any } | { ok: false; error: string }

/** Calls a tool, returning its JSON result, or the error message the model would read. */
async function call(app: TestApp, auth: string, tool: string, args: unknown): Promise<ToolResult> {
  const response = await rpc(app, auth, 'tools/call', { name: tool, arguments: args })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const { result } = response.body
  const text: string = result.content[0].text
  return result.isError ? { ok: false, error: text } : { ok: true, value: JSON.parse(text) }
}

async function value(result: Promise<ToolResult>) {
  const settled = await result
  assert.ok(settled.ok, settled.ok ? '' : settled.error)
  return settled.value
}

async function error(result: Promise<ToolResult>) {
  const settled = await result
  assert.ok(!settled.ok, `expected a tool error, got ${JSON.stringify(settled)}`)
  return settled.error
}

const ids = (expenses: { id: number }[]) => expenses.map((expense) => expense.id)

test('only bearer tokens authenticate, and the handshake lists every tool', async (t) => {
  const { app, auth } = await setup(t)
  const initialize = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  }

  for (const headers of [{}, USER_1, { authorization: 'Bearer exp_unknown' }]) {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize }
    const response = await app.request('POST', '/mcp', body, { ...headers, ...ACCEPT })
    assert.equal(response.status, 401, JSON.stringify(headers))
    assert.equal(
      response.headers['www-authenticate'],
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    )
    assert.equal(response.body.message, 'Unauthorized')
  }

  const response = await rpc(app, auth, 'initialize', initialize)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.match(response.headers['content-type']!, /^application\/json/)
  const { result } = response.body
  assert.equal(result.protocolVersion, '2025-06-18')
  assert.equal(result.serverInfo.name, 'expenser')
  assert.equal(typeof result.capabilities.tools, 'object')
  assert.match(result.instructions, /ARS/)

  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }
  const notified = await app.request('POST', '/mcp', initialized, { authorization: auth, ...ACCEPT, ...PROTOCOL_VERSION })
  assert.equal(notified.status, 202)

  const tools = (await rpc(app, auth, 'tools/list', {})).body.result.tools
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), [
    'add_category',
    'add_expense',
    'delete_category',
    'delete_expense',
    'get_profile',
    'get_summary',
    'list_categories',
    'list_expenses',
    'update_category',
    'update_expense',
    'update_profile',
  ])
  const getSummary = tools.find((tool: { name: string }) => tool.name === 'get_summary')
  assert.deepEqual(getSummary.annotations, { readOnlyHint: true })

  // There are no sessions to open a stream on or end.
  for (const method of ['GET', 'DELETE']) {
    const response = await app.request(method, '/mcp', undefined, { authorization: auth, ...ACCEPT })
    assert.equal(response.status, 405, method)
  }

  // Newer clients skip the handshake and send their protocol version with every request.
  const modern = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'get_profile',
      arguments: {},
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }
  const modernResponse = await app.request('POST', '/mcp', modern, {
    authorization: auth,
    ...ACCEPT,
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call',
    'mcp-name': 'get_profile',
  })
  assert.equal(modernResponse.status, 200, JSON.stringify(modernResponse.body))
  assert.equal(JSON.parse(modernResponse.body.result.content[0].text).id, 1)
})

test('expenses are added by category name, updated and deleted', async (t) => {
  const { app, auth } = await setup(t)

  const added = await value(call(app, auth, 'add_expense', { amount: 4500, description: 'Taxi', category: ' transport ' }))
  assert.equal(added.category, 'Transport')
  assert.equal(added.date, '2026-10-22')
  const rest = (await app.get(`/expenses/${added.id}`)).body
  assert.equal(rest.description, 'Taxi')
  assert.equal(rest.amount, 4500)

  const dated = await value(
    call(app, auth, 'add_expense', { amount: 1200, description: 'Coffee', category: 'Food', date: '2026-10-20' }),
  )
  assert.equal(dated.date, '2026-10-20')

  for (const [args, message] of [
    [
      { amount: 1, description: 'x', category: 'Other user' },
      'There is no category named "Other user". The user\'s categories are: Food, Transport',
    ],
    [{ amount: 0, description: 'x', category: 'Food' }, 'Amount must be greater than 0'],
    [
      { amount: 1, description: 'x', category: 'Food', date: '2026-10-23' },
      'Enter a valid expense date on or before today (YYYY-MM-DD)',
    ],
  ] as const) {
    assert.equal(await error(call(app, auth, 'add_expense', args)), message, JSON.stringify(args))
  }
  assert.match(await error(call(app, auth, 'add_expense', { amount: 1 })), /description/)

  const id = dated.id
  const updated = await value(call(app, auth, 'update_expense', { id, amount: 1500, category: 'TRANSPORT' }))
  assert.equal(updated.amount, 1500)
  assert.equal(updated.category, 'Transport')
  assert.equal(updated.description, 'Coffee')
  assert.equal(updated.date, '2026-10-20')
  assert.equal(await error(call(app, auth, 'update_expense', { id })), 'Nothing to update')
  // Models often send null for what they leave out.
  const nulls = await value(call(app, auth, 'update_expense', { id, amount: 1600, category: null, date: null }))
  assert.equal(nulls.category, 'Transport')

  const otherUsers = await app.seedExpense('2026-10-21T12:00:00', 900, 2)
  for (const tool of ['update_expense', 'delete_expense']) {
    assert.equal(await error(call(app, auth, tool, { id: otherUsers, amount: 1 })), 'Expense not found', tool)
  }

  const deleted = await value(call(app, auth, 'delete_expense', { id }))
  assert.equal(deleted.description, 'Coffee')
  assert.equal((await app.get(`/expenses/${id}`)).status, 404)
})

test('summaries and expense searches cover the requested days of the user', async (t) => {
  const { app, auth } = await setup(t)
  const add = async (amount: number, description: string, category: string, date: string) =>
    (await value(call(app, auth, 'add_expense', { amount, description, category, date }))).id as number
  const before = await add(100, 'Groceries', 'Food', '2026-10-09')
  const first = await add(200, 'Taxi home', 'Transport', '2026-10-10')
  const groceries = await add(300, 'Supermarket groceries', 'Food', '2026-10-12')
  const taxi = await add(400, 'Taxi', 'Transport', '2026-10-16')
  const after = await add(800, 'Dinner', 'Food', '2026-10-17')
  const last = await app.seedExpense('2026-10-16T23:59:59.999', 50, 1)
  await app.seedExpense('2026-10-12T12:00:00', 900, 2)

  const week = await value(call(app, auth, 'list_expenses', { from: '2026-10-10', to: '2026-10-16' }))
  assert.equal(week.count, 4)
  assert.equal(week.total, 950)
  assert.deepEqual(week.byCategory, [
    { category: 'Transport', count: 2, total: 600 },
    { category: 'Food', count: 2, total: 350 },
  ])
  assert.deepEqual(ids(week.expenses), [last, taxi, groceries, first])
  assert.equal(week.expenses[0].date, '2026-10-16')

  assert.deepEqual(ids((await value(call(app, auth, 'list_expenses', { category: 'FOOD' }))).expenses), [
    after,
    last,
    groceries,
    before,
  ])
  assert.deepEqual(ids((await value(call(app, auth, 'list_expenses', { search: 'groceries' }))).expenses), [
    groceries,
    before,
  ])

  const newest = await value(call(app, auth, 'list_expenses', { limit: 1 }))
  assert.equal(newest.count, 6)
  assert.equal(newest.total, 1850)
  assert.deepEqual(ids(newest.expenses), [after])

  for (const [args, message] of [
    [{ from: '2026-13-01' }, 'from must be a date (YYYY-MM-DD)'],
    [{ to: 'yesterday' }, 'to must be a date (YYYY-MM-DD)'],
    [{ from: '2026-10-16', to: '2026-10-10' }, 'from must be on or before to'],
  ] as const) {
    assert.equal(await error(call(app, auth, 'list_expenses', args)), message, JSON.stringify(args))
  }

  const current = await value(call(app, auth, 'get_summary', {}))
  assert.equal(current.weekStart, '2026-10-17')
  assert.equal(current.today, '2026-10-22')
  assert.equal(current.spent, 800)
  assert.equal(current.monthly.spent, 1850)
  const past = await value(call(app, auth, 'get_summary', { weekStart: '2026-10-10' }))
  assert.equal(past.spent, 950)
  assert.equal(past.available, 50)
  assert.match(await error(call(app, auth, 'get_summary', { weekStart: '2026-10-11' })), /^weekStart must be a Saturday/)
})

test('categories and the profile are managed for the user', async (t) => {
  const { app, auth } = await setup(t)

  assert.deepEqual(ids(await value(call(app, auth, 'list_categories', {}))), [1, 2])

  const added = await value(call(app, auth, 'add_category', { name: 'Gym', color: '#22c55e' }))
  assert.equal(added.name, 'Gym')
  assert.equal(added.userId, 1)
  const renamed = await value(call(app, auth, 'update_category', { id: added.id, name: 'Sports' }))
  assert.equal(renamed.name, 'Sports')
  assert.equal(renamed.color, '#22c55e')
  const deleted = await value(call(app, auth, 'delete_category', { id: added.id }))
  assert.equal(deleted.name, 'Sports')
  assert.equal((await app.get(`/categories/${added.id}`)).status, 404)
  for (const tool of ['update_category', 'delete_category']) {
    assert.equal(await error(call(app, auth, tool, { id: 3, name: 'Mine' })), 'Category not found', tool)
  }

  const profile = await value(call(app, auth, 'get_profile', {}))
  assert.equal(profile.name, 'User 1')
  assert.equal(profile.expendableAmountPerWeek, 1000)
  const updated = await value(call(app, auth, 'update_profile', { expendableAmountPerWeek: 2000 }))
  assert.equal(updated.expendableAmountPerWeek, 2000)
  assert.equal(updated.name, 'User 1')
  assert.equal((await value(call(app, auth, 'get_summary', {}))).allowance, 2000)
  assert.equal(
    await error(call(app, auth, 'update_profile', { expendableAmountPerWeek: -1 })),
    'Invalid expendable amount',
  )
})
