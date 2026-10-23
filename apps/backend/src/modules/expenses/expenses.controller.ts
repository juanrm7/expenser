import type { FastifyInstance } from 'fastify'
import { ExpensesService } from './expenses.service.js'
import { CategoriesService } from '../categories/categories.service.js'
import type { CreateExpenseRequest, UpdateExpenseRequest, UpdateExpenseBody } from './expenses.types.js'
import { requireAuth } from '../../lib/auth-plugin.js'
import { formatDate, getWeekStart, parseDate } from './expenses.dates.js'

const service = new ExpensesService()
const categoriesService = new CategoriesService()

const expenseProperties = {
  amount: { type: 'number', exclusiveMinimum: 0 },
  description: { type: 'string' },
  categoryId: { type: 'integer', minimum: 1 },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
} as const

export async function expensesController(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/expenses', async (req) => {
    return service.getAll(req.user!.id)
  })

  app.get<{ Querystring: { weekStart?: string } }>('/expenses/summary', async (req, reply) => {
    const { weekStart } = req.query
    if (weekStart === undefined) return service.getWeeklySummary(req.user!)
    const date = parseDate(weekStart)
    if (!date || date.getDay() !== 6 || date > getWeekStart()) {
      return reply.status(400).send({ message: 'weekStart must be a Saturday on or before the current week (YYYY-MM-DD)' })
    }
    return service.getWeeklySummary(req.user!, date)
  })

  app.get<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
    const expense = await service.getById(req.user!.id, Number(req.params.id))

    if (!expense) return reply.status(404).send({ message: 'Expense not found' })

    return expense
  })

  app.post<{ Body: CreateExpenseRequest }>('/expenses', {
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'description', 'categoryId'],
        additionalProperties: false,
        properties: expenseProperties,
      },
    },
  }, async (req, reply) => {
    const { categoryId, date, ...rest } = req.body
    const createdAt = date === undefined ? undefined : parseDate(date)
    if (createdAt === null || (date !== undefined && date > formatDate(new Date()))) {
      return reply.status(400).send({ message: 'Enter a valid expense date on or before today (YYYY-MM-DD)' })
    }

    const category = await categoriesService.getById(req.user!.id, categoryId)

    if (!category) return reply.status(404).send({ message: 'Category not found' })

    const expense = await service.create(req.user!.id, { ...rest, category: category.name, createdAt })

    return reply.status(201).send(expense)
  })

  app.patch<{ Params: { id: string }; Body: UpdateExpenseRequest }>(
    '/expenses/:id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: expenseProperties,
        },
      },
    },
    async (req, reply) => {
      const { categoryId, date, ...rest } = req.body
      const data: UpdateExpenseBody = { ...rest }
      if (date !== undefined) {
        const createdAt = parseDate(date)
        if (!createdAt || date > formatDate(new Date())) {
          return reply.status(400).send({ message: 'Enter a valid expense date on or before today (YYYY-MM-DD)' })
        }
        data.createdAt = createdAt
      }

      if (categoryId !== undefined) {
        const category = await categoriesService.getById(req.user!.id, categoryId)
        if (!category) return reply.status(404).send({ message: 'Category not found' })
        data.category = category.name
      }

      const expense = await service.update(req.user!.id, Number(req.params.id), data)
      if (!expense) return reply.status(404).send({ message: 'Expense not found' })
      return expense
    }
  )

  app.delete<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
    const ok = await service.delete(req.user!.id, Number(req.params.id))
    if (!ok) return reply.status(404).send({ message: 'Expense not found' })
    return reply.status(204).send()
  })
}
