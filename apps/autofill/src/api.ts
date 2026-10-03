import { env } from './env.js'
import type { ExpenseSink, ExtractedExpense } from './types.js'

interface Category {
  id: number
  name: string
}

/** Writes expenses straight to the Expenser backend, authenticated with a per-user API key. */
export class ExpenserApi implements ExpenseSink {
  private categoryIds = new Map<string, number>()

  static async open(): Promise<ExpenserApi> {
    const api = new ExpenserApi()
    await api.loadCategories()
    console.log(`[expenser] using API key at ${env.expenserApiUrl}`)
    return api
  }

  async getCategories(): Promise<string[]> {
    const names = [...this.categoryIds.keys()]
    if (names.length === 0) throw new Error('The Expenser account has no categories')
    return names
  }

  async addExpense(expense: ExtractedExpense): Promise<void> {
    const categoryId = this.categoryIds.get(expense.category)
    if (categoryId === undefined) throw new Error(`Unknown category "${expense.category}"`)

    await this.request('/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: expense.amount, description: expense.description, categoryId }),
    })
  }

  async close(): Promise<void> {}

  private async loadCategories(): Promise<void> {
    const categories = (await (await this.request('/categories')).json()) as Category[]
    this.categoryIds = new Map(categories.map(c => [c.name, c.id]))
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${env.expenserApiUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${env.expenserApiKey}` },
    })
    if (res.status === 401) {
      throw new Error('Expenser rejected the API key (revoked or mistyped?) — check EXPENSER_API_KEY')
    }
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} returned ${res.status}: ${await res.text().catch(() => '')}`)
    }
    return res
  }
}
