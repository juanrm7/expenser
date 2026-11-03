import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db/index.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

// apps/backend/.env, from src/ (dev) and dist/ alike. It's optional; variables already set in the
// environment (e.g. by pm2) take precedence over it.
const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  const config = loadConfig()
  const { client, db } = await openDatabase(config.databaseUrl, config.databaseAuthToken)
  const app = buildApp({ db, config, now: () => new Date() })

  // Ctrl+C / SIGINT (what pm2 sends) or SIGTERM: stop accepting requests, let in-flight ones finish.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      process.stdout.write('Shutting down\n')
      await app.close()
      client.close()
      process.exit(0)
    })
  }

  await app.listen({ host: config.host, port: config.port })
  process.stdout.write(`${GREEN}${BOLD}✓ Server listening on http://${config.host}:${config.port}${RESET}\n`)
} catch (err) {
  process.stderr.write(`${RED}${BOLD}✗ Failed to start server${RESET}\n`)
  console.error(err)
  process.exit(1)
}
