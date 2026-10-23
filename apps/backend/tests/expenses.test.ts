import assert from 'node:assert/strict'
import { after, before, beforeEach, test, mock } from 'node:test'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import { formatDate, getWeekStart, parseDate } from '../src/modules/expenses/expenses.dates.js'

const directory = await mkdtemp(join(tmpdir(), 'expenser-history-'))
process.env.TURSO_DATABASE_URL = pathToFileURL(join(directory, 'test.db')).href
delete process.env.TURSO_AUTH_TOKEN
const { default: prisma } = await import('../src/lib/prisma.js')
const realNow = Date.now.bind(Date)
const { expensesController } = await import('../src/modules/expenses/expenses.controller.js')

const app = Fastify()
app.decorateRequest('user', null)
app.addHook('preHandler', async req => {
  if (req.headers['x-test-user'] === 'anonymous') return
  req.user = {
    id: Number(req.headers['x-test-user'] ?? 1),
    name: 'Test user',
    email: 'test@example.com',
    expendableAmountPerWeek: 1000,
    role: 'user',
  }
})
app.register(expensesController)

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-22T12:00:00').getTime() })
  const migrations = new URL('../prisma/migrations/', import.meta.url)
  const directories = (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  for (const directory of directories) {
    const sql = await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8')
    for (const statement of sql.split(';').filter(statement => statement.trim())) {
      await prisma.$executeRawUnsafe(statement)
    }
  }
  await prisma.user.createMany({ data: [
    { id: 1, name: 'First', email: 'first@example.com', passwordHash: 'test', expendableAmountPerWeek: 1000 },
    { id: 2, name: 'Second', email: 'second@example.com', passwordHash: 'test', expendableAmountPerWeek: 1000 },
  ] })
  await prisma.category.createMany({ data: [
    { id: 1, name: 'Food', color: '#10b981', userId: 1 },
    { id: 2, name: 'Transport', color: '#3b82f6', userId: 1 },
    { id: 3, name: 'Other user', color: '#3b82f6', userId: 2 },
  ] })
  await app.ready()
})

beforeEach(async () => {
  await prisma.expense.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  mock.timers.reset()
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function seedExpense(date: string, amount: number, userId = 1) {
  const expense = await prisma.expense.create({ data: {
    userId, amount, description: 'Existing expense', category: 'Food', createdAt: new Date(date),
  } })
  return expense
}

test('week starts on Saturday across month, year, and leap-day boundaries', () => {
  for (const [date, expected] of [
    ['2026-10-17', '2026-10-17'],
    ['2026-10-18', '2026-10-17'],
    ['2026-10-23', '2026-10-17'],
    ['2026-01-01', '2025-12-27'],
    ['2024-03-01', '2024-02-24'],
  ]) {
    assert.equal(formatDate(getWeekStart(new Date(`${date}T12:00:00`))), expected)
  }
  assert.equal(parseDate('2026-02-30'), null)
  assert.equal(parseDate('2026-2-03'), null)
  assert.equal(formatDate(parseDate('2024-02-29')!), '2024-02-29')
})

test('historical summary includes Saturday through Friday only and remains scoped to the user', async () => {
  await seedExpense('2026-10-09T23:59:59.999', 5)
  const first = await seedExpense('2026-10-10T00:00:00', 100)
  const last = await seedExpense('2026-10-16T23:59:59.999', 200)
  await seedExpense('2026-10-17T00:00:00', 400)
  await seedExpense('2026-10-12T12:00:00', 900, 2)
  const response = await app.inject('/expenses/summary?weekStart=2026-10-10')
  assert.equal(response.statusCode, 200)
  const summary = response.json()
  assert.equal(summary.weekStart, '2026-10-10')
  assert.equal(summary.currentWeekStart, '2026-10-17')
  assert.equal(summary.today, '2026-10-22')
  assert.deepEqual(summary.expenses.map((expense: { id: number }) => expense.id), [last.id, first.id])
  assert.deepEqual(summary.expenses.map((expense: { date: string }) => expense.date), ['2026-10-16', '2026-10-10'])
  assert.equal(summary.spent, 300)
  assert.equal(summary.available, 700)
  assert.equal(summary.monthly.spent, 705)
})

test('default summary still shows the current week and empty historical weeks have zero spent', async () => {
  await seedExpense('2026-10-16T12:00:00', 100)
  await seedExpense('2026-10-17T12:00:00', 200)
  const current = (await app.inject('/expenses/summary')).json()
  assert.equal(current.weekStart, '2026-10-17')
  assert.equal(current.spent, 200)
  const empty = (await app.inject('/expenses/summary?weekStart=2026-01-03')).json()
  assert.deepEqual(empty.expenses, [])
  assert.equal(empty.spent, 0)
  assert.equal(empty.available, 1000)
})

test('invalid, non-Saturday, and future weeks are rejected', async () => {
  for (const value of ['invalid', '', '2026-02-30', '2026-10-11', '2026-10-24']) {
    assert.equal((await app.inject(`/expenses/summary?weekStart=${value}`)).statusCode, 400)
  }
})

test('a missed expense can be created, edited, and deleted while browsing a historical week', async () => {
  const created = await app.inject({
    method: 'POST', url: '/expenses',
    payload: { amount: 100, description: 'Missed lunch', categoryId: 1, date: '2026-10-12' },
  })
  assert.equal(created.statusCode, 201)
  const expense = created.json()
  assert.equal(formatDate(new Date(expense.createdAt)), '2026-10-12')
  const edited = await app.inject({
    method: 'PATCH', url: `/expenses/${expense.id}`,
    payload: { amount: 150, description: 'Corrected lunch', categoryId: 2 },
  })
  assert.equal(edited.statusCode, 200)
  assert.equal(edited.json().category, 'Transport')
  assert.equal(edited.json().createdAt, expense.createdAt)
  const summary = (await app.inject('/expenses/summary?weekStart=2026-10-10')).json()
  assert.equal(summary.spent, 150)
  assert.equal(summary.monthly.spent, 150)
  assert.equal(summary.expenses[0].description, 'Corrected lunch')
  assert.equal((await app.inject('/expenses/summary')).json().spent, 0)
  assert.equal((await app.inject({ method: 'DELETE', url: `/expenses/${expense.id}` })).statusCode, 204)
  assert.equal((await app.inject('/expenses/summary?weekStart=2026-10-10')).json().spent, 0)
})

test('editing a saved category needs no category ID and changing date moves the expense between weeks', async () => {
  await prisma.expense.create({ data: {
    id: 1000, userId: 1, amount: 100, description: 'Old expense', category: 'Deleted category',
    createdAt: new Date('2026-09-30T12:00:00'),
  } })
  const response = await app.inject({ method: 'PATCH', url: '/expenses/1000', payload: { amount: 125, date: '2026-10-12' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().category, 'Deleted category')
  assert.equal((await app.inject('/expenses/summary?weekStart=2026-09-26')).json().spent, 0)
  const summary = (await app.inject('/expenses/summary?weekStart=2026-10-10')).json()
  assert.equal(summary.spent, 125)
  assert.equal(summary.monthly.spent, 125)
})

test('creation without a date preserves the existing current-time default', async () => {
  const before = realNow()
  const response = await app.inject({ method: 'POST', url: '/expenses', payload: { amount: 10, description: '', categoryId: 1 } })
  assert.equal(response.statusCode, 201)
  const createdAt = new Date(response.json().createdAt).getTime()
  assert.ok(createdAt >= before && createdAt <= realNow())
})

test('invalid dates and non-positive amounts cannot be created or saved', async () => {
  const expense = await seedExpense('2026-10-12T12:00:00', 100)
  for (const payload of [{ date: '2026-02-30' }, { date: '2026-10-23' }, { date: 'invalid' }, { amount: 0 }, { amount: -10 }]) {
    const created = await app.inject({ method: 'POST', url: '/expenses', payload: { amount: 10, description: '', categoryId: 1, ...payload } })
    assert.equal(created.statusCode, 400)
    const updated = await app.inject({ method: 'PATCH', url: `/expenses/${expense.id}`, payload })
    assert.equal(updated.statusCode, 400)
  }
})

test('historical expenses and category IDs belonging to another user cannot be changed', async () => {
  const expense = await seedExpense('2026-10-12T12:00:00', 100, 2)
  assert.equal((await app.inject({ method: 'PATCH', url: `/expenses/${expense.id}`, payload: { amount: 1 } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/expenses/${expense.id}` })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: '/expenses', payload: { amount: 1, description: '', categoryId: 3, date: '2026-10-12' } })).statusCode, 404)
  assert.equal((await app.inject({ url: '/expenses/summary?weekStart=2026-10-10', headers: { 'x-test-user': 'anonymous' } })).statusCode, 401)
})
