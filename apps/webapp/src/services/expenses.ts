import { env } from '../config/environment'

export interface Expense {
  id: number
  description: string
  amount: number
  category: string
  createdAt: Date
  updatedAt: Date
}

export interface ExpenseSummary {
  weekStart: string
  allowance: number
  spent: number
  available: number
  expenses: Expense[]
}

export async function getExpenses(): Promise<Expense[]> {
  const response = await fetch(`${env.backendUrl}/expenses`)
  return response.json()
}

export async function getExpenseSummary(): Promise<ExpenseSummary> {
  const response = await fetch(`${env.backendUrl}/expenses/summary`)
  return response.json()
}
