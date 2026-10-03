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
