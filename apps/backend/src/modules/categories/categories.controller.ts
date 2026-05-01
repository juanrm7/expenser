import type { FastifyInstance } from 'fastify'
import { CategoriesService } from './categories.service.js'
import type { CreateCategoryBody, UpdateCategoryBody } from './categories.types.js'
import { requireAuth } from '../../lib/auth-plugin.js'

const service = new CategoriesService()

export async function categoriesController(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/categories', async (req) => {
    return service.getAll(req.user!.id)
  })

  app.get<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    const category = await service.getById(req.user!.id, Number(req.params.id))
    if (!category) return reply.status(404).send({ message: 'Category not found' })
    return category
  })

  app.post<{ Body: CreateCategoryBody }>('/categories', async (req, reply) => {
    const category = await service.create(req.user!.id, req.body)
    return reply.status(201).send(category)
  })

  app.patch<{ Params: { id: string }; Body: UpdateCategoryBody }>(
    '/categories/:id',
    async (req, reply) => {
      const category = await service.update(req.user!.id, Number(req.params.id), req.body)
      if (!category) return reply.status(404).send({ message: 'Category not found' })
      return category
    }
  )

  app.delete<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    const ok = await service.delete(req.user!.id, Number(req.params.id))
    if (!ok) return reply.status(404).send({ message: 'Category not found' })
    return reply.status(204).send()
  })
}
