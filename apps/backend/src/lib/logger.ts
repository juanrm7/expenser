// Request logging: one colored line per response on stdout, and the details of every 5xx on stderr.
// Credentials (cookies, bearer tokens, passwords, OAuth codes and tokens) are never logged.

import type { FastifyInstance, FastifyRequest } from 'fastify'

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

const SECRET_HEADERS = new Set(['authorization', 'cookie'])
const SECRET_FIELDS = new Set(['password', 'code', 'code_verifier', 'refresh_token'])

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
  return new Date().toTimeString().slice(0, 8)
}

function redact(record: unknown, secrets: Set<string>): unknown {
  if (!record || typeof record !== 'object') return record
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, secrets.has(key.toLowerCase()) ? '[redacted]' : value]),
  )
}

/** Writes an unexpected error, and what it happened during, to stderr. */
export function logError(details: Record<string, unknown>, err: unknown): void {
  const error = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause } : err
  process.stderr.write(
    `${c.red}${c.bold}--- ERROR DETAILS ---${c.reset}\n` +
      JSON.stringify({ ...details, error }, null, 2) +
      `\n${c.red}${c.bold}---------------------${c.reset}\n`,
  )
}

/** `lines: false` drops the line per response (for tests); 5xx details are always written. */
export function registerRequestLogging(app: FastifyInstance, { lines = true } = {}): void {
  const errors = new WeakMap<FastifyRequest, unknown>()

  app.addHook('onError', async (req, _reply, err) => {
    errors.set(req, err)
  })

  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode
    const duration = reply.elapsedTime
    if (lines) {
      const id = `${c.magenta}[${req.id.slice(0, 8)}]${c.reset}`
      process.stdout.write(
        `${c.dim}${shortTimestamp()}${c.reset} ${colorMethod(req.method)} ${req.url} ${colorStatus(status)} ` +
          `${c.dim}${duration.toFixed(1)}ms${c.reset} ${id}\n`,
      )
    }

    if (status >= 500) {
      logError(
        {
          correlationId: req.id,
          method: req.method,
          url: req.url,
          status,
          durationMs: Number(duration.toFixed(1)),
          params: req.params ?? {},
          query: req.query ?? {},
          body: typeof req.body === 'string' ? `[${req.body.length} characters]` : redact(req.body, SECRET_FIELDS),
          headers: redact(req.headers, SECRET_HEADERS),
          userId: req.user?.id ?? null,
        },
        errors.get(req) ?? null,
      )
    }
  })
}
