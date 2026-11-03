// Runtime configuration: every environment variable the backend reads (see .env.example),
// validated at startup.

export interface Config {
  host: string
  port: number
  /**
   * Where clients reach this API, without a trailing slash: the OAuth issuer, and the base of the
   * MCP server's URL (`${apiUrl}/mcp`).
   */
  apiUrl: string
  /** The webapp's origin: the only one CORS allows, and where OAuth consent happens. */
  webappUrl: string
  cookieSecure: boolean
  cookieSameSite: 'lax' | 'strict' | 'none'
  /** `libsql://…` for Turso, otherwise a local SQLite file (`file:` prefix optional). */
  databaseUrl: string
  /** Only needed for remote (Turso) databases. */
  databaseAuthToken: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT || 3001)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a port number, not ${JSON.stringify(env.PORT)}`)
  }

  const apiUrl = (env.API_URL || `http://localhost:${port}`).replace(/\/+$/, '')
  if (!isHttpUrl(apiUrl)) throw new Error(`API_URL must be an http(s) URL, not ${JSON.stringify(apiUrl)}`)

  const webappUrl = env.WEBAPP_URL || 'http://localhost:4321'
  if (!isHttpUrl(webappUrl) || new URL(webappUrl).origin !== webappUrl) {
    throw new Error(`WEBAPP_URL must be an origin like http://localhost:4321, not ${JSON.stringify(webappUrl)}`)
  }

  const cookieSameSite = env.SESSION_COOKIE_SAMESITE || 'lax'
  if (cookieSameSite !== 'lax' && cookieSameSite !== 'strict' && cookieSameSite !== 'none') {
    throw new Error(`SESSION_COOKIE_SAMESITE must be lax, strict or none, not ${JSON.stringify(cookieSameSite)}`)
  }

  return {
    host: env.HOST || '0.0.0.0',
    port,
    apiUrl,
    webappUrl,
    cookieSecure: env.SESSION_COOKIE_SECURE === 'true',
    cookieSameSite,
    databaseUrl: env.TURSO_DATABASE_URL || 'file:./dev.db',
    databaseAuthToken: env.TURSO_AUTH_TOKEN || '',
  }
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol)
}
