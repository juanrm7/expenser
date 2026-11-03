import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { requireUser } from '../../lib/auth.js'
import { parse, parseId } from '../../lib/errors.js'
import {
  addExpense,
  createExpenseBody,
  deleteExpense,
  editExpense,
  getExpense,
  listExpenses,
  summarize,
  updateExpenseBody,
} from './expenses.service.js'

type IdParams = { Params: { id: string } }

/** A previous week to show, by its Saturday (`YYYY-MM-DD`); the current week by default. */
const summaryQuery = z.object({ weekStart: z.string().optional() })

export function expensesController(ctx: Context): FastifyPluginAsync {
  return async (app) => {
    app.get('/expenses', async (req) => {
      const user = await requireUser(ctx, req)
      return listExpenses(ctx, user.id)
    })

    app.get('/expenses/summary', async (req) => {
      const user = await requireUser(ctx, req)
      return summarize(ctx, user, parse(summaryQuery, req.query).weekStart)
    })

    app.get<IdParams>('/expenses/:id', async (req) => {
      const user = await requireUser(ctx, req)
      return getExpense(ctx, user.id, parseId(req.params.id))
    })

    app.post('/expenses', async (req, reply) => {
      const user = await requireUser(ctx, req)
      const expense = await addExpense(ctx, user, parse(createExpenseBody, req.body))
      reply.status(201)
      return expense
    })

    app.patch<IdParams>('/expenses/:id', async (req) => {
      const user = await requireUser(ctx, req)
      return editExpense(ctx, user, parseId(req.params.id), parse(updateExpenseBody, req.body))
    })

    app.delete<IdParams>('/expenses/:id', async (req, reply) => {
      const user = await requireUser(ctx, req)
      await deleteExpense(ctx, user, parseId(req.params.id))
      return reply.status(204).send()
    })
  }
}
