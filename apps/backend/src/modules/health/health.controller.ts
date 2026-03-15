import type { FastifyInstance } from 'fastify'
import { HealthService } from './health.service.js'

const service = new HealthService()

export async function healthController(app: FastifyInstance) {
  app.get('/health', async () => {
    return service.hello()
  })
}
