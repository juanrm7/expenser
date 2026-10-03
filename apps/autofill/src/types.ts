export interface ExtractedExpense {
  amount: number
  description: string
  category: string
  /** Transaction date as YYYY-MM-DD, or "" when the image doesn't show one */
  date: string
  /** Merchant/transaction text exactly as printed (e.g. "Merpago coto") — stable key for dedup */
  merchant: string
}

export interface Extraction {
  expenses: ExtractedExpense[]
  /** Free-text remark from the model (e.g. "image is blurry", "total only, no line items") */
  notes: string
}

/** Where extracted expenses get written: the backend API, or the webapp via Playwright. */
export interface ExpenseSink {
  /** Category names the user has, used to steer Gemini and to resolve categoryId */
  getCategories(): Promise<string[]>
  addExpense(expense: ExtractedExpense): Promise<void>
  close(): Promise<void>
}
