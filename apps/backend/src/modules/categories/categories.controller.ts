import type { FastifyPluginAsync } from 'fastify'
import type { Context } from '../../context.js'
import { requireUser } from '../../lib/auth.js'
import { parse, parseId } from '../../lib/errors.js'
import {
  addCategory,
  createCategoryBody,
  deleteCategory,
  editCategory,
  getCategory,
  listCategories,
  updateCategoryBody,
} from './categories.service.js'

type IdParams = { Params: { id: string } }

export function categoriesController(ctx: Context): FastifyPluginAsync {
  return async (app) => {
    app.get('/categories', async (req) => {
      const user = await requireUser(ctx, req)
      return listCategories(ctx, user.id)
    })

    app.get<IdParams>('/categories/:id', async (req) => {
      const user = await requireUser(ctx, req)
      return getCategory(ctx, user.id, parseId(req.params.id))
    })

    app.post('/categories', async (req, reply) => {
      const user = await requireUser(ctx, req)
      const category = await addCategory(ctx, user.id, parse(createCategoryBody, req.body))
      reply.status(201)
      return category
    })

    app.patch<IdParams>('/categories/:id', async (req) => {
      const user = await requireUser(ctx, req)
      return editCategory(ctx, user.id, parseId(req.params.id), parse(updateCategoryBody, req.body))
    })

    app.delete<IdParams>('/categories/:id', async (req, reply) => {
      const user = await requireUser(ctx, req)
      await deleteCategory(ctx, user.id, parseId(req.params.id))
      return reply.status(204).send()
    })
  }
}
