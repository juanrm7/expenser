export interface ExtractedExpense {
  amount: number
  description: string
  category: string
}

export interface Extraction {
  expenses: ExtractedExpense[]
  /** Free-text remark from the model (e.g. "image is blurry", "total only, no line items") */
  notes: string
}
