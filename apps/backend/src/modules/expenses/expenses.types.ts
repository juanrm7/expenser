export interface Expense {
  id: number
  description: string
  amount: number
  category: string
  createdAt: Date
  updatedAt: Date
}

export type CreateExpenseBody = Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>
export type UpdateExpenseBody = Partial<CreateExpenseBody>

export type CreateExpenseRequest = Omit<CreateExpenseBody, 'category'> & { categoryId: number }
export type UpdateExpenseRequest = Omit<UpdateExpenseBody, 'category'> & { categoryId?: number }
