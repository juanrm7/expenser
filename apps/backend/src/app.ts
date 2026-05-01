import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { env } from './lib/env.js'
import { authPlugin } from './lib/auth-plugin.js'
import { correlationPlugin } from './lib/correlation-plugin.js'
import { loggerPlugin } from './lib/logger-plugin.js'
import { healthController } from './modules/health/health.controller.js'
import { authController } from './modules/auth/auth.controller.js'
import { categoriesController } from './modules/categories/categories.controller.js'
import { expensesController } from './modules/expenses/expenses.controller.js'

export function buildApp() {
  const app = Fastify({
    logger: { level: 'silent' },
    disableRequestLogging: true,
  })

  app.register(cors, {
    origin: env.webappUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-correlation-id'],
  })

  app.register(cookie)
  app.register(correlationPlugin)
  app.register(loggerPlugin)
  app.register(authPlugin)

  app.register(healthController)
  app.register(authController)
  app.register(categoriesController)
  app.register(expensesController)

  return app
}
