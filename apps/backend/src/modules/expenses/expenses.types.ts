export interface Expense {
  id: number
  description: string
  amount: number
  category: string
  createdAt: Date
  updatedAt: Date
}

export type CreateExpenseBody = Omit<Expense, 'id' | 'createdAt' | 'updatedAt'> & { createdAt?: Date }
export type UpdateExpenseBody = Partial<CreateExpenseBody>

export type CreateExpenseRequest = Omit<CreateExpenseBody, 'category' | 'createdAt'> & {
  categoryId: number
  date?: string
}
export type UpdateExpenseRequest = Partial<CreateExpenseRequest>
