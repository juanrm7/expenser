export const env = {
  port: Number(process.env.PORT) || 3001,
  webappUrl: process.env.WEBAPP_URL || 'http://localhost:4321',
  cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  databaseUrl: process.env.DATABASE_URL || '',
}
