import { useState, useEffect } from 'react'
import { formatARS } from '../lib/data'
import type { ExpenseSummary } from '../services/expenses'
import { createExpense, deleteExpense, getExpenseSummary } from '../services/expenses'
import type { Category } from '../services/categories'

interface Props {
  summary: ExpenseSummary
  categories: Category[]
}

export function ExpenseTracker({ summary: initialSummary, categories }: Props) {
  const [summary, setSummary] = useState(initialSummary)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (categories.length === 0) {
      setCategoryId(null)
      return
    }
    const valid = categories.some(c => c.id === categoryId)
    if (!valid) setCategoryId(categories[0].id)
  }, [categories])

  const { allowance, spent, available, expenses, weekStart } = summary
  const isOver = available < 0
  const pctUsed = Math.min((spent / allowance) * 100, 100)

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    const parsed = parseFloat(amount.replace(',', '.'))
    if (!parsed || parsed <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (!categoryId) {
      setError('Select a category')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await createExpense({ amount: parsed, description, categoryId })
      setAmount('')
      setDescription('')
      setSummary(await getExpenseSummary())
    } catch {
      setError('Failed to add expense. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const weekLabel = new Date(weekStart + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">

      {/* Balance card */}
      <div className={`rounded-2xl p-5 text-white shadow-md ${isOver ? 'bg-red-500' : 'bg-indigo-600'}`}>
        <p className="text-sm font-medium opacity-80">Remaining — week of {weekLabel}</p>
        <p className="text-4xl font-bold mt-1 tabular-nums">{formatARS(available)}</p>
        <div className="mt-4">
          <div className="flex justify-between text-xs opacity-75 mb-1">
            <span>{formatARS(spent)} spent</span>
            <span>{formatARS(allowance)} budget</span>
          </div>
          <div className="w-full bg-white/30 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${isOver ? 'bg-red-200' : 'bg-white'}`}
              style={{ width: `${pctUsed}%` }}
            />
          </div>
        </div>
      </div>

      {/* Overspent banner */}
      {isOver && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <span className="mt-0.5 text-red-500 shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-5a1 1 0 00-1 1v2a1 1 0 002 0V9a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold text-red-700">Over budget this week</p>
            <p className="text-xs text-red-500 mt-0.5">
              You've exceeded your weekly allowance by {formatARS(Math.abs(available))}.
            </p>
          </div>
        </div>
      )}

      {/* Add expense form */}
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
        <h2 className="font-semibold text-gray-700">Add expense</h2>

        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            placeholder="Amount in ARS"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <select
            value={categoryId ?? ''}
            onChange={e => setCategoryId(Number(e.target.value))}
            disabled={categories.length === 0}
            className="border border-gray-200 rounded-xl px-3 py-3 text-gray-800 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
          >
            {categories.length === 0 && <option value="">No categories</option>}
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-4 py-3 text-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />

        {error && <p className="text-red-500 text-xs">{error}</p>}

        <button
          type="submit"
          disabled={categories.length === 0 || submitting}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {submitting ? 'Adding…' : 'Add Expense'}
        </button>
      </form>

      {/* Expense list */}
      {expenses.length > 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          <h2 className="font-semibold text-gray-700 px-5 py-4">This week</h2>
          {expenses.map(expense => {
            const match = categories.find(c => c.name === expense.category)
            return (
              <div key={expense.id} className="flex items-center justify-between px-5 py-3 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="text-xs font-medium px-2 py-1 rounded-lg shrink-0 text-white"
                    style={match ? { backgroundColor: match.color } : { backgroundColor: '#e5e7eb', color: '#4b5563' }}
                  >
                    {expense.category}
                  </span>
                  <span className="text-sm text-gray-500 truncate">
                    {expense.description || '—'}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-semibold text-gray-800">{formatARS(expense.amount)}</span>
                  <button
                    onClick={async () => {
                      await deleteExpense(expense.id)
                      setSummary(await getExpenseSummary())
                    }}
                    className="text-gray-300 hover:text-red-400 transition-colors"
                    aria-label="Delete expense"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-center text-sm text-gray-400 py-4">No expenses logged this week.</p>
      )}

    </div>
  )
}
