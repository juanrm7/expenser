export const env = {
  port: Number(process.env.PORT) || 3001,
  webappUrl: process.env.WEBAPP_URL || 'http://localhost:4321',
  cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  cookieSameSite: (process.env.SESSION_COOKIE_SAMESITE as 'lax' | 'strict' | 'none') || 'lax',
  databaseUrl: process.env.DATABASE_URL || '',
}
