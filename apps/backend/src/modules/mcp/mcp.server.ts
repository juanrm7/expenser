// The MCP tools through which AI assistants such as Claude read and manage the user's expenses,
// categories and allowance. Each tool calls the same service function as the REST route, so both
// validate identically.

import { createRequire } from 'node:module'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { expenses } from '../../db/schema.js'
import { addDays, parseDate } from '../../lib/dates.js'
import { AppError } from '../../lib/errors.js'
import { logError } from '../../lib/logger.js'
import { updateProfile, type User } from '../auth/auth.service.js'
import { addCategory, deleteCategory, editCategory, listCategories } from '../categories/categories.service.js'
import { addExpense, dated, deleteExpense, editExpense, summarize } from '../expenses/expenses.service.js'

const INSTRUCTIONS =
  "Expenser tracks the user's spending in Argentine pesos (ARS) against a weekly allowance. Weeks " +
  'run Saturday through Friday; the monthly allowance is the weekly one prorated over the days of ' +
  "the month. Dates are calendar dates (YYYY-MM-DD) in the user's time zone, and get_summary tells " +
  "you today's. Every expense belongs to one of the user's categories, named when adding it: check " +
  'list_categories first, and only add a category when the user asks.'

/** How many expenses `list_expenses` returns by default, and at most. */
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

const { version } = createRequire(import.meta.url)('../../../package.json') as { version: string }

const id = (what: string) => z.number().int().describe(`The ${what}'s id.`)
const color = z.string().describe('The color the app shows it in, as #rrggbb, e.g. #10b981.')

const listExpensesArgs = z.object({
  from: z.string().nullish().describe('Only expenses on or after this date (YYYY-MM-DD).'),
  to: z.string().nullish().describe('Only expenses on or before this date (YYYY-MM-DD).'),
  category: z.string().nullish().describe('Only expenses in this category, by name (ignoring case).'),
  search: z.string().nullish().describe('Only expenses whose description contains this text (ignoring case).'),
  limit: z
    .number()
    .int()
    .min(0)
    .nullish()
    .describe('How many of the matching expenses to return, newest first: 100 if omitted, at most 500.'),
})

/** The MCP server for one request, acting as `user`. */
export function buildMcpServer(ctx: Context, user: User, correlationId: string): McpServer {
  const server = new McpServer(
    { name: 'expenser', title: 'Expenser', version },
    // The tools never change, so clients needn't listen for changes.
    { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: false } } },
  )

  /** A tool's result: the value as JSON, or an error the model can read and act on. */
  const reply = async (tool: string, work: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await work()) }] }
    } catch (err) {
      if (err instanceof AppError) return { content: [{ type: 'text', text: err.message }], isError: true }
      logError({ correlationId, tool, userId: user.id }, err)
      return { content: [{ type: 'text', text: 'Internal Server Error' }], isError: true }
    }
  }

  /** The id of the user's category with this name (ignoring case). */
  const categoryId = async (name: string): Promise<number> => {
    const categories = await listCategories(ctx, user.id)
    const wanted = name.trim().toLowerCase()
    const category = categories.find((category) => category.name.trim().toLowerCase() === wanted)
    if (category) return category.id
    const names = categories.map((category) => category.name).join(', ')
    throw AppError.notFound(`There is no category named ${JSON.stringify(name)}. The user's categories are: ${names}`)
  }

  server.registerTool(
    'get_summary',
    {
      description:
        'The balance of a week (allowance, spent, available and its expenses) and of the current month to ' +
        "date, plus today's date and the current week's start.",
      inputSchema: z.object({
        weekStart: z
          .string()
          .nullish()
          .describe('The Saturday (YYYY-MM-DD) a past week starts on; the current week if omitted.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ weekStart }) => reply('get_summary', () => summarize(ctx, user, weekStart ?? undefined)),
  )

  server.registerTool(
    'list_expenses',
    {
      description:
        "Searches the user's expenses. Returns the count and total of all matches, overall and per category, " +
        'and the matching expenses themselves, newest first up to `limit`.',
      inputSchema: listExpensesArgs,
      annotations: { readOnlyHint: true },
    },
    (args) => reply('list_expenses', () => findExpenses(ctx, user, args)),
  )

  server.registerTool(
    'add_expense',
    {
      description: 'Records an expense.',
      inputSchema: z.object({
        amount: z.number().describe('The amount in ARS, greater than 0.'),
        description: z.string().describe('What it was for, e.g. "Lunch with Ana".'),
        category: z.string().describe("The name of one of the user's categories."),
        date: z.string().nullish().describe('The day it happened (YYYY-MM-DD), today or earlier; now if omitted.'),
      }),
      annotations: { destructiveHint: false },
    },
    ({ category, ...args }) =>
      reply('add_expense', async () => {
        const body = { ...args, categoryId: await categoryId(category) }
        return dated(await addExpense(ctx, user, body))
      }),
  )

  server.registerTool(
    'update_expense',
    {
      description: 'Changes an expense; omitted fields keep their value.',
      inputSchema: z.object({
        id: id('expense'),
        amount: z.number().nullish().describe('The new amount in ARS, greater than 0.'),
        description: z.string().nullish(),
        category: z.string().nullish().describe("The name of one of the user's categories."),
        date: z.string().nullish().describe('The day it happened (YYYY-MM-DD), today or earlier.'),
      }),
    },
    ({ id, category, ...changes }) =>
      reply('update_expense', async () => {
        const body = { ...changes, categoryId: category == null ? undefined : await categoryId(category) }
        return dated(await editExpense(ctx, user, id, body))
      }),
  )

  server.registerTool(
    'delete_expense',
    {
      description: 'Deletes an expense, returning it.',
      inputSchema: z.object({ id: id('expense') }),
    },
    ({ id }) => reply('delete_expense', async () => dated(await deleteExpense(ctx, user, id))),
  )

  server.registerTool(
    'list_categories',
    { description: "The user's expense categories.", annotations: { readOnlyHint: true } },
    () => reply('list_categories', () => listCategories(ctx, user.id)),
  )

  server.registerTool(
    'add_category',
    {
      description: 'Creates an expense category.',
      inputSchema: z.object({ name: z.string(), color }),
      annotations: { destructiveHint: false },
    },
    (args) => reply('add_category', () => addCategory(ctx, user.id, args)),
  )

  server.registerTool(
    'update_category',
    {
      description: 'Renames or recolors a category. Expenses already in it keep the name they were saved with.',
      inputSchema: z.object({ id: id('category'), name: z.string().nullish(), color: color.nullish() }),
    },
    ({ id, ...changes }) => reply('update_category', () => editCategory(ctx, user.id, id, changes)),
  )

  server.registerTool(
    'delete_category',
    {
      description: 'Deletes a category, returning it. Expenses in it keep its name.',
      inputSchema: z.object({ id: id('category') }),
    },
    ({ id }) => reply('delete_category', () => deleteCategory(ctx, user.id, id)),
  )

  server.registerTool(
    'get_profile',
    {
      description: "The user's name, email and weekly allowance (`expendableAmountPerWeek`, in ARS).",
      annotations: { readOnlyHint: true },
    },
    () => reply('get_profile', async () => user),
  )

  server.registerTool(
    'update_profile',
    {
      description: "Changes the user's name or weekly allowance; omitted fields keep their value.",
      inputSchema: z.object({
        name: z.string().nullish(),
        expendableAmountPerWeek: z.number().nullish().describe('The weekly allowance in ARS, 0 or more.'),
      }),
    },
    (args) => reply('update_profile', () => updateProfile(ctx, user, args)),
  )

  return server
}

/** `list_expenses`: the user's expenses matching the filters, with totals over every match. */
async function findExpenses(ctx: Context, user: User, args: z.output<typeof listExpensesArgs>) {
  const date = (value: string | null | undefined, name: string) => {
    if (value == null) return undefined
    const day = parseDate(value)
    if (!day) throw AppError.badRequest(`${name} must be a date (YYYY-MM-DD)`)
    return day
  }
  const from = date(args.from, 'from')
  const to = date(args.to, 'to')
  if (from && to && from.getTime() > to.getTime()) throw AppError.badRequest('from must be on or before to')

  const conditions: (SQL | undefined)[] = [
    eq(expenses.userId, user.id),
    from && gte(expenses.createdAt, from),
    to && lt(expenses.createdAt, addDays(to, 1)),
    args.category == null ? undefined : sql`${expenses.category} = ${args.category} COLLATE NOCASE`,
    args.search == null ? undefined : sql`instr(lower(${expenses.description}), lower(${args.search})) > 0`,
  ]
  const matches = await ctx.db
    .select()
    .from(expenses)
    .where(and(...conditions))
    .orderBy(desc(expenses.createdAt), desc(expenses.id))

  const byCategory: { category: string; count: number; total: number }[] = []
  for (const expense of matches) {
    const total = byCategory.find((total) => total.category === expense.category)
    if (total) {
      total.count += 1
      total.total += expense.amount
    } else {
      byCategory.push({ category: expense.category, count: 1, total: expense.amount })
    }
  }
  byCategory.sort((a, b) => b.total - a.total)

  const limit = Math.min(args.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
  return {
    count: matches.length,
    total: matches.reduce((sum, expense) => sum + expense.amount, 0),
    byCategory,
    expenses: matches.slice(0, limit).map(dated),
  }
}
