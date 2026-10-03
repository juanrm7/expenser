import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')

try {
  process.loadEnvFile(resolve(appRoot, '.env'))
} catch {
  // No .env file — rely on the real environment
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name} — set it in apps/autofill/.env (see .env.example)`)
  return value
}

function dir(name: string, fallback: string): string {
  return resolve(appRoot, process.env[name]?.trim() || fallback)
}

export const env = {
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash',
  expenserUrl: required('EXPENSER_URL').replace(/\/+$/, ''),
  expenserEmail: required('EXPENSER_EMAIL'),
  expenserPassword: required('EXPENSER_PASSWORD'),
  inboxDir: dir('INBOX_DIR', './inbox'),
  processedDir: dir('PROCESSED_DIR', './processed'),
  failedDir: dir('FAILED_DIR', './failed'),
  headless: process.env.HEADLESS?.trim().toLowerCase() !== 'false',
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH?.trim() || undefined,
  authStatePath: resolve(appRoot, '.auth/state.json'),
  ledgerPath: resolve(appRoot, 'ledger.json'),
}
