import { useState, useEffect } from 'react'
import type { ExpenseSummary } from '../services/expenses'
import { getExpenseSummary } from '../services/expenses'
import type { Category } from '../services/categories'
import { getCategories } from '../services/categories'
import { Header } from '../components/Header'
import { ExpenseTracker } from '../templates/ExpenseTracker'

export function HomePage() {
  const [summary, setSummary] = useState<ExpenseSummary | null>(null)
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    async function fetchData() {
      const [summary, categories] = await Promise.all([getExpenseSummary(), getCategories()])
      setSummary(summary)
      setCategories(categories)
    }

    fetchData()
  }, [])

  if (!summary) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Header page="home" />
      <ExpenseTracker summary={summary} categories={categories} />
    </div>
  )
}
