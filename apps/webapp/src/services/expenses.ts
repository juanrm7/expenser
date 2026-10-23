import { apiFetch } from '../lib/apiFetch'

export interface Expense {
  id: number
  description: string
  amount: number
  category: string
  createdAt: string
  updatedAt: string
}

export interface MonthlySummary {
  monthStart: string
  allowance: number
  spent: number
  available: number
}

export interface WeeklyExpense extends Expense {
  date: string
}

export interface ExpenseSummary {
  weekStart: string
  currentWeekStart: string
  today: string
  allowance: number
  spent: number
  available: number
  expenses: WeeklyExpense[]
  monthly: MonthlySummary
}

export async function getExpenses(): Promise<Expense[]> {
  const response = await apiFetch('/expenses')
  return response.json()
}

export async function getExpenseSummary(weekStart?: string): Promise<ExpenseSummary> {
  const query = weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''
  const response = await apiFetch(`/expenses/summary${query}`)
  if (!response.ok) throw new Error('Failed to load expenses')
  return response.json()
}

export async function deleteExpense(id: number): Promise<void> {
  const response = await apiFetch(`/expenses/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error('Failed to delete expense')
}

export interface ExpensePayload {
  amount: number
  description: string
  categoryId: number
  date?: string
}

export async function createExpense(payload: ExpensePayload): Promise<Expense> {
  const response = await apiFetch('/expenses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('Failed to create expense')
  return response.json()
}

export async function updateExpense(id: number, payload: Partial<ExpensePayload>): Promise<Expense> {
  const response = await apiFetch(`/expenses/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error('Failed to update expense')
  return response.json()
}
