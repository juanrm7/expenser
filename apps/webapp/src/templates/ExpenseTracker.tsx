import { useState, useEffect } from 'react'
import { formatARS } from '../lib/data'
import type { ExpenseSummary } from '../services/expenses'
import type { Category } from '../services/categories'

interface Props {
  summary: ExpenseSummary
  categories: Category[]
}

export function ExpenseTracker({ summary, categories }: Props) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (categories.length === 0) {
      setCategory('')
      return
    }
    const valid = categories.some(c => c.name === category)
    if (!valid) setCategory(categories[0].name)
  }, [categories])

  const { allowance, spent, available, expenses, weekStart } = summary
  const isOver = available < 0
  const pctUsed = Math.min((spent / allowance) * 100, 100)

  function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    const parsed = parseFloat(amount.replace(',', '.'))
    if (!parsed || parsed <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (!category) {
      setError('Select a category')
      return
    }
    setError('')
    setAmount('')
    setDescription('')
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
            value={category}
            onChange={e => setCategory(e.target.value)}
            disabled={categories.length === 0}
            className="border border-gray-200 rounded-xl px-3 py-3 text-gray-800 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
          >
            {categories.length === 0 && <option value="">No categories</option>}
            {categories.map(c => (
              <option key={c.id} value={c.name}>{c.name}</option>
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
          disabled={categories.length === 0}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          Add Expense
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
                <span className="text-sm font-semibold text-gray-800 shrink-0">{formatARS(expense.amount)}</span>
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
