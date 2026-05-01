import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

// ANSI color codes
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}

function colorStatus(status: number): string {
  if (status >= 500) return `${c.red}${c.bold}${status}${c.reset}`
  if (status >= 400) return `${c.yellow}${c.bold}${status}${c.reset}`
  if (status >= 300) return `${c.cyan}${status}${c.reset}`
  if (status >= 200) return `${c.green}${status}${c.reset}`
  return `${c.gray}${status}${c.reset}`
}

function colorMethod(method: string): string {
  switch (method) {
    case 'GET':
      return `${c.blue}${method}${c.reset}`
    case 'POST':
      return `${c.green}${method}${c.reset}`
    case 'PATCH':
    case 'PUT':
      return `${c.yellow}${method}${c.reset}`
    case 'DELETE':
      return `${c.red}${method}${c.reset}`
    default:
      return `${c.white}${method}${c.reset}`
  }
}

function shortTimestamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

const loggerPluginAsync: FastifyPluginAsync = async (app) => {
  // Track per-request errors so we can dump full info on error
  const errors = new WeakMap<object, unknown>()

  app.addHook('onError', async (req, _reply, err) => {
    errors.set(req, err)
  })

  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode
    const method = req.method
    const url = req.url
    const corrId = req.correlationId ?? ''
    const duration = reply.elapsedTime
    const durationStr = `${duration.toFixed(1)}ms`
    const ts = `${c.dim}${shortTimestamp()}${c.reset}`
    const idTag = corrId ? `${c.magenta}[${shortId(corrId)}]${c.reset}` : ''

    const line = `${ts} ${colorMethod(method)} ${url} ${colorStatus(status)} ${c.dim}${durationStr}${c.reset} ${idTag}`

    // Use process.stdout.write to avoid pino formatting
    process.stdout.write(line + '\n')

    // On error or 5xx, dump the full request/error context
    const err = errors.get(req)
    if (err || status >= 500) {
      const details = {
        correlationId: corrId,
        method,
        url,
        status,
        durationMs: Number(duration.toFixed(1)),
        params: (req.params as unknown) ?? {},
        query: (req.query as unknown) ?? {},
        body: (req.body as unknown) ?? null,
        headers: req.headers,
        userId: req.user?.id ?? null,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err ?? null,
      }
      process.stderr.write(
        `${c.red}${c.bold}--- ERROR DETAILS ---${c.reset}\n` +
          JSON.stringify(details, null, 2) +
          `\n${c.red}${c.bold}---------------------${c.reset}\n`
      )
    }
  })
}

export const loggerPlugin = fp(loggerPluginAsync, { name: 'logger-plugin' })
