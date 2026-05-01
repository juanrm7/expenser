import type { FastifyInstance } from 'fastify'
import { ExpensesService } from './expenses.service.js'
import { CategoriesService } from '../categories/categories.service.js'
import type { CreateExpenseRequest, UpdateExpenseRequest } from './expenses.types.js'
import { requireAuth } from '../../lib/auth-plugin.js'

const service = new ExpensesService()
const categoriesService = new CategoriesService()

export async function expensesController(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/expenses', async (req) => {
    return service.getAll(req.user!.id)
  })

  app.get('/expenses/summary', async (req) => {
    return service.getWeeklySummary(req.user!)
  })

  app.get<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
    const expense = await service.getById(req.user!.id, Number(req.params.id))

    if (!expense) return reply.status(404).send({ message: 'Expense not found' })

    return expense
  })

  app.post<{ Body: CreateExpenseRequest }>('/expenses', async (req, reply) => {
    const { categoryId, ...rest } = req.body

    const category = await categoriesService.getById(req.user!.id, categoryId)

    if (!category) return reply.status(404).send({ message: 'Category not found' })

    const expense = await service.create(req.user!.id, { ...rest, category: category.name })

    return reply.status(201).send(expense)
  })

  app.patch<{ Params: { id: string }; Body: UpdateExpenseRequest }>(
    '/expenses/:id',
    async (req, reply) => {
      const { categoryId, ...rest } = req.body
      let data: Record<string, unknown> = rest

      if (categoryId !== undefined) {
        const category = await categoriesService.getById(req.user!.id, categoryId)
        if (!category) return reply.status(404).send({ message: 'Category not found' })
        data = { ...rest, category: category.name }
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
