import type { Config } from './config.js'
import type { Database } from './db/index.js'

/** What request handlers, services and MCP tools run with. */
export interface Context {
  db: Database
  config: Config
  /** The current time. Use it rather than `new Date()`, so tests can fix "today". */
  now: () => Date
}
