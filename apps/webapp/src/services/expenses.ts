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

export async function deleteExpense(id: number): Promise<void> {
  const response = await fetch(`${env.backendUrl}/expenses/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete expense')
}

export async function createExpense(payload: {
  amount: number
  description: string
  categoryId: number
}): Promise<Expense> {
  const response = await fetch(`${env.backendUrl}/expenses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('Failed to create expense')
  return response.json()
}
