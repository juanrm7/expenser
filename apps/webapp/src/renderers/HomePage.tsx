import { useState, useEffect } from 'react'
import type { AppConfig } from '../lib/data'
import { loadConfig } from '../lib/data'
import type { Expense } from '../services/expenses'
import { getExpenses } from '../services/expenses'
import type { Category } from '../services/categories'
import { getCategories } from '../services/categories'
import { Header } from '../components/Header'
import { ExpenseTracker } from '../templates/ExpenseTracker'

export function HomePage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    async function fetchData() {
      setConfig(loadConfig())
      const [expenses, categories] = await Promise.all([getExpenses(), getCategories()])
      setExpenses(expenses)
      setCategories(categories)
    }

    fetchData()
  }, [])

  if (!config) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Header page="home" />
      <ExpenseTracker config={config} expenses={expenses} categories={categories} />
    </div>
  )
}
