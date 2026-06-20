import { useState, useEffect } from 'react'
import type { ExpenseSummary } from '../services/expenses'
import { getExpenseSummary } from '../services/expenses'
import type { Category } from '../services/categories'
import { getCategories } from '../services/categories'
import { Header } from '../components/Header'
import { HeaderSkeleton, HomeSkeleton } from '../components/HomeSkeleton'
import { ExpenseTracker } from '../templates/ExpenseTracker'
import { useAuth } from '../lib/useAuth'
import { readHomeCache, writeHomeCache } from '../lib/cache'

export function HomePage() {
  const { user } = useAuth()
  const [summary, setSummary] = useState<ExpenseSummary | null>(null)
  const [categories, setCategories] = useState<Category[]>([])

  // Paint the last-known data instantly (stale-while-revalidate).
  useEffect(() => {
    const cached = readHomeCache()
    if (cached) {
      setSummary(cached.summary)
      setCategories(cached.categories)
    }
  }, [])

  // Refresh from the API once we know who the user is.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    async function fetchData() {
      const [summary, categories] = await Promise.all([getExpenseSummary(), getCategories()])
      if (cancelled) return
      setSummary(summary)
      setCategories(categories)
      writeHomeCache({ summary, categories })
    }

    fetchData()
    return () => {
      cancelled = true
    }
  }, [user])

  return (
    <div className="min-h-screen bg-gray-50">
      {user ? <Header page="home" user={user} /> : <HeaderSkeleton />}
      {summary ? (
        <ExpenseTracker summary={summary} categories={categories} />
      ) : (
        <HomeSkeleton />
      )}
    </div>
  )
}
