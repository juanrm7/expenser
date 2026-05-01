import { buildApp } from './app.js'

const port = Number(process.env.PORT) || 3001
const host = '0.0.0.0'

const app = buildApp()

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

try {
  await app.listen({ port, host })
  process.stdout.write(`${GREEN}${BOLD}✓ Server listening on http://${host}:${port}${RESET}\n`)
} catch (err) {
  process.stderr.write(`${RED}${BOLD}✗ Failed to start server${RESET}\n`)
  console.error(err)
  process.exit(1)
}
