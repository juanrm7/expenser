import { env } from '../config/environment'

export interface Expense {
  id: number
  description: string
  amount: number
  category: string
  createdAt: Date
  updatedAt: Date
}

export async function getExpenses(): Promise<Expense[]> {
  const response = await fetch(`${env.backendUrl}/expenses`)
  return response.json()
}
