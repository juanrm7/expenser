// Expenser's REST API: per-user weekly/monthly expense tracking in ARS.

import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import Fastify, { type FastifyError } from 'fastify'
import type { Context } from './context.js'
import { AppError } from './lib/errors.js'
import { registerRequestLogging } from './lib/logger.js'
import { apiKeysController } from './modules/api-keys/api-keys.controller.js'
import { authController } from './modules/auth/auth.controller.js'
import { categoriesController } from './modules/categories/categories.controller.js'
import { expensesController } from './modules/expenses/expenses.controller.js'
import { mcpController } from './modules/mcp/mcp.controller.js'
import { oauthController } from './modules/oauth/oauth.controller.js'

/**
 * Ties a request's log line to the webapp's console logs: taken from the request (or generated)
 * and echoed on the response.
 */
const CORRELATION_ID = 'x-correlation-id'

export function buildApp(ctx: Context, options: { requestLog?: boolean } = {}) {
  const app = Fastify({
    logger: false,
    requestIdHeader: CORRELATION_ID,
    genReqId: () => randomUUID(),
  })

  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req, reply) => {
    reply.header(CORRELATION_ID, req.id)
  })
  registerRequestLogging(app, { lines: options.requestLog ?? true })

  app.register(cors, {
    origin: ctx.config.webappUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: [CORRELATION_ID],
  })
  app.register(cookie)

  // Every error body is `{ "message": "…" }`. Unexpected errors are logged (see lib/logger.ts).
  app.setErrorHandler<FastifyError | AppError>((err, _req, reply) => {
    const status = err instanceof AppError ? err.status : (err.statusCode ?? 500)
    if (status < 400 || status >= 500) return reply.status(500).send({ message: 'Internal Server Error' })
    return reply.status(status).send({ message: err.message })
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ message: 'Route not found' }))

  app.get('/health', async () => ({ message: 'Hello World' }))
  app.register(authController(ctx))
  app.register(categoriesController(ctx))
  app.register(expensesController(ctx))
  app.register(apiKeysController(ctx))
  app.register(mcpController(ctx))
  app.register(oauthController(ctx))

  return app
}
