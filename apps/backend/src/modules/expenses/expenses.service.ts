// Per-user expenses, and the weekly/monthly summary the home screen is built from.

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { one } from '../../db/index.js'
import { expenses } from '../../db/schema.js'
import {
  addDays,
  daysInMonth,
  formatDate,
  monthStart,
  parseDate,
  startOfDay,
  weekStart as weekStartOf,
} from '../../lib/dates.js'
import { AppError, given } from '../../lib/errors.js'
import type { User } from '../auth/auth.service.js'
import { findCategory } from '../categories/categories.service.js'

export type Expense = typeof expenses.$inferSelect

/** An expense with its local calendar date, so clients in other time zones show and edit the same day. */
export type DatedExpense = Expense & { date: string }

export function dated(expense: Expense): DatedExpense {
  return { ...expense, date: formatDate(expense.createdAt) }
}

const notFound = () => AppError.notFound('Expense not found')
const newestFirst = [desc(expenses.createdAt), desc(expenses.id)]

export function listExpenses(ctx: Context, userId: number): Promise<Expense[]> {
  return ctx.db
    .select()
    .from(expenses)
    .where(eq(expenses.userId, userId))
    .orderBy(...newestFirst)
}

export async function getExpense(ctx: Context, userId: number, id: number): Promise<Expense> {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.userId, userId)))
  if (!expense) throw notFound()
  return expense
}

/**
 * The balance of the week starting on `weekStart` (a Saturday, `YYYY-MM-DD`; the current week if
 * omitted), and of the current calendar month to date.
 */
export async function summarize(ctx: Context, user: User, weekStart?: string) {
  const now = ctx.now()
  const currentWeekStart = weekStartOf(now)
  let start = currentWeekStart
  if (weekStart !== undefined) {
    const date = parseDate(weekStart)
    if (!date || date.getDay() !== 6 || date.getTime() > currentWeekStart.getTime()) {
      throw AppError.badRequest('weekStart must be a Saturday on or before the current week (YYYY-MM-DD)')
    }
    start = date
  }
  const month = monthStart(now)

  const weekExpenses = await ctx.db
    .select()
    .from(expenses)
    .where(
      and(eq(expenses.userId, user.id), gte(expenses.createdAt, start), lt(expenses.createdAt, addDays(start, 7))),
    )
    .orderBy(...newestFirst)
  const { monthlySpent } = one(
    await ctx.db
      .select({ monthlySpent: sql<number>`TOTAL(${expenses.amount})` })
      .from(expenses)
      .where(
        and(
          eq(expenses.userId, user.id),
          gte(expenses.createdAt, month),
          lt(expenses.createdAt, addDays(month, daysInMonth(now))),
        ),
      ),
  )

  const allowance = user.expendableAmountPerWeek
  const spent = weekExpenses.reduce((sum, expense) => sum + expense.amount, 0)
  const monthlyAllowance = (allowance / 7) * daysInMonth(now)

  return {
    weekStart: formatDate(start),
    currentWeekStart: formatDate(currentWeekStart),
    today: formatDate(now),
    allowance,
    spent,
    available: allowance - spent,
    expenses: weekExpenses.map(dated),
    monthly: {
      monthStart: formatDate(month),
      allowance: monthlyAllowance,
      spent: monthlySpent,
      available: monthlyAllowance - monthlySpent,
    },
  }
}

export const createExpenseBody = z.object({
  amount: z.number(),
  description: z.string(),
  categoryId: z.number().int(),
  /** `YYYY-MM-DD`, on or before today; the expense is recorded as happening now if omitted. */
  date: z.string().nullish(),
})

export async function addExpense(ctx: Context, user: User, body: z.output<typeof createExpenseBody>): Promise<Expense> {
  const now = ctx.now()
  checkAmount(body.amount)
  const date = given(body.date)
  const createdAt = date === undefined ? now : expenseDate(date, now)
  const category = await findCategory(ctx, user.id, body.categoryId)
  if (!category) throw AppError.notFound('Category not found')

  return one(
    await ctx.db
      .insert(expenses)
      .values({
        description: body.description,
        amount: body.amount,
        category: category.name,
        createdAt,
        updatedAt: now,
        userId: user.id,
      })
      .returning(),
  )
}

/**
 * Omitted fields keep their value: an expense whose category was deleted keeps its name, and one
 * without a new `date` keeps its original one.
 */
export const updateExpenseBody = z.object({
  amount: z.number().nullish(),
  description: z.string().nullish(),
  categoryId: z.number().int().nullish(),
  date: z.string().nullish(),
})

export async function editExpense(
  ctx: Context,
  user: User,
  id: number,
  body: z.output<typeof updateExpenseBody>,
): Promise<Expense> {
  const amount = given(body.amount)
  const description = given(body.description)
  const categoryId = given(body.categoryId)
  const date = given(body.date)
  if (amount === undefined && description === undefined && categoryId === undefined && date === undefined) {
    throw AppError.badRequest('Nothing to update')
  }
  const now = ctx.now()
  if (amount !== undefined) checkAmount(amount)
  const createdAt = date === undefined ? undefined : expenseDate(date, now)
  let category: string | undefined
  if (categoryId !== undefined) {
    const found = await findCategory(ctx, user.id, categoryId)
    if (!found) throw AppError.notFound('Category not found')
    category = found.name
  }

  const [expense] = await ctx.db
    .update(expenses)
    .set({ amount, description, category, createdAt, updatedAt: now })
    .where(and(eq(expenses.id, id), eq(expenses.userId, user.id)))
    .returning()
  if (!expense) throw notFound()
  return expense
}

/** Deletes an expense, returning it. */
export async function deleteExpense(ctx: Context, user: User, id: number): Promise<Expense> {
  const [expense] = await ctx.db
    .delete(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.userId, user.id)))
    .returning()
  if (!expense) throw notFound()
  return expense
}

function checkAmount(amount: number): void {
  if (!(amount > 0)) throw AppError.badRequest('Amount must be greater than 0')
}

/** The instant an expense dated `YYYY-MM-DD` is recorded at: the start of that (past) day. */
function expenseDate(date: string, now: Date): Date {
  const day = parseDate(date)
  if (!day || day.getTime() > startOfDay(now).getTime()) {
    throw AppError.badRequest('Enter a valid expense date on or before today (YYYY-MM-DD)')
  }
  return day
}
