import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { env } from './env.js'
import type { ExtractedExpense } from './types.js'

interface LedgerEntry {
  key: string
  date: string
  merchant: string
  amount: number
  description: string
  source: string
  addedAt: string
}

/**
 * Local record of every expense the bot has added, so overlapping screenshots (e.g. a card's
 * "Tus consumos" list taken on consecutive days) don't log the same transaction twice.
 */
export class Ledger {
  private constructor(private entries: LedgerEntry[]) {}

  static async load(): Promise<Ledger> {
    if (!existsSync(env.ledgerPath)) return new Ledger([])
    return new Ledger(JSON.parse(await readFile(env.ledgerPath, 'utf8')) as LedgerEntry[])
  }

  /**
   * Dedup keys for one image's expenses: date + amount + merchant text, plus an occurrence
   * counter so two identical purchases on the same day (two 7.900 coffees) stay distinct —
   * and are matched again as #1 and #2 when a later screenshot shows both.
   */
  static keysFor(expenses: ExtractedExpense[]): string[] {
    const seen = new Map<string, number>()
    return expenses.map(e => {
      const merchant = (e.merchant || e.description).toLowerCase().replace(/\s+/g, ' ')
      const base = `${e.date}|${e.amount.toFixed(2)}|${merchant}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return `${base}#${n}`
    })
  }

  has(key: string): boolean {
    return this.entries.some(e => e.key === key)
  }

  /** Records an expense and saves immediately, so a crash mid-batch never causes a re-add. */
  async add(key: string, expense: ExtractedExpense, source: string): Promise<void> {
    const { date, merchant, amount, description } = expense
    this.entries.push({ key, date, merchant, amount, description, source, addedAt: new Date().toISOString() })
    await writeFile(env.ledgerPath, JSON.stringify(this.entries, null, 2) + '\n')
  }
}
