import { useState, useRef } from 'react'
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import { formatARS } from '../lib/data'
import { addDays, dateLabel } from '../lib/dates'
import type { WeeklyExpense, ExpenseSummary } from '../services/expenses'
import { createExpense, deleteExpense, getExpenseSummary, updateExpense } from '../services/expenses'
import type { Category } from '../services/categories'

interface Props {
  summary: ExpenseSummary
  categories: Category[]
}

export function ExpenseTracker({ summary: initialSummary, categories }: Props) {
  const [summary, setSummary] = useState(initialSummary)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(categories[0]?.id ?? null)
  const [date, setDate] = useState(initialSummary.today)
  const [editingExpense, setEditingExpense] = useState<WeeklyExpense | null>(null)
  const [error, setError] = useState('')
  const [pageError, setPageError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [loadingWeek, setLoadingWeek] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const operationInProgress = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)

  const { allowance, spent, available, expenses, weekStart, currentWeekStart, today, monthly } = summary
  const isCurrentWeek = weekStart === currentWeekStart
  const weekEnd = addDays(weekStart, 6)
  const maxDate = weekEnd < today ? weekEnd : today
  const busy = submitting || loadingWeek || deletingId !== null
  const isOver = available < 0
  const pctUsed = allowance > 0 ? Math.min((spent / allowance) * 100, 100) : spent > 0 ? 100 : 0
  const monthOver = monthly.available < 0
  const monthPctUsed = monthly.allowance > 0 ? Math.min((monthly.spent / monthly.allowance) * 100, 100) : monthly.spent > 0 ? 100 : 0
  const monthLabel = new Date(monthly.monthStart + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long',
  })

  function resetForm(nextSummary = summary) {
    setEditingExpense(null)
    setAmount('')
    setDescription('')
    setCategoryId(categories[0]?.id ?? null)
    setDate(nextSummary.weekStart === nextSummary.currentWeekStart ? nextSummary.today : nextSummary.weekStart)
    setError('')
  }

  async function loadWeek(nextWeek?: string) {
    if (operationInProgress.current) return
    operationInProgress.current = true
    setLoadingWeek(true)
    setPageError('')
    try {
      const fresh = await getExpenseSummary(nextWeek)
      setSummary(fresh)
      resetForm(fresh)
    } catch {
      setPageError('Failed to load expenses. Please try again.')
    } finally {
      operationInProgress.current = false
      setLoadingWeek(false)
    }
  }

  async function refreshAfterChange() {
    try {
      setSummary(await getExpenseSummary(weekStart))
    } catch {
      setPageError('Your change was saved, but totals could not be refreshed. Reload this week to see the latest expenses.')
    }
  }

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    if (operationInProgress.current) return
    const parsed = Number(amount.replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (!categoryId && !editingExpense) {
      setError('Select a category')
      return
    }
    if (!date || date < weekStart || date > maxDate) {
      setError('Choose a date in the selected week, on or before today')
      return
    }
    operationInProgress.current = true
    setError('')
    setPageError('')
    setSubmitting(true)
    try {
      if (editingExpense) {
        await updateExpense(editingExpense.id, {
          amount: parsed,
          description,
          ...(categoryId !== null ? { categoryId } : {}),
          ...(date !== editingExpense.date ? { date } : {}),
        })
      } else {
        await createExpense({
          amount: parsed,
          description,
          categoryId: categoryId!,
          ...(date !== today ? { date } : {}),
        })
      }
      resetForm()
      await refreshAfterChange()
    } catch {
      setError(`Failed to ${editingExpense ? 'update' : 'add'} expense. Please try again.`)
    } finally {
      operationInProgress.current = false
      setSubmitting(false)
    }
  }

  function startEditing(expense: WeeklyExpense) {
    setEditingExpense(expense)
    setAmount(String(expense.amount))
    setDescription(expense.description)
    setCategoryId(categories.find(c => c.name === expense.category)?.id ?? null)
    setDate(expense.date)
    setError('')
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    formRef.current?.querySelector('input')?.focus({ preventScroll: true })
  }

  async function handleDelete(id: number) {
    if (operationInProgress.current) return
    operationInProgress.current = true
    setDeletingId(id)
    setPageError('')
    try {
      await deleteExpense(id)
      if (editingExpense?.id === id) resetForm()
      await refreshAfterChange()
    } catch {
      setPageError('Failed to delete expense. Please try again.')
    } finally {
      operationInProgress.current = false
      setDeletingId(null)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5" aria-busy={busy}>
      <nav aria-label="Expense week" className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => loadWeek(addDays(weekStart, -7))}
            disabled={busy}
            aria-label="Previous week"
            className="p-2 rounded-xl text-gray-500 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40 transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="min-w-0 text-center" aria-live="polite" role="status">
            <p className="text-sm font-semibold text-gray-800">{loadingWeek ? 'Loading week…' : isCurrentWeek ? 'This week' : 'Previous week'}</p>
            <p className="text-xs text-gray-500 mt-0.5">{dateLabel(weekStart)} – {dateLabel(weekEnd)}</p>
          </div>
          <button
            type="button"
            onClick={() => loadWeek(addDays(weekStart, 7))}
            disabled={busy || isCurrentWeek}
            aria-label="Next week"
            className="p-2 rounded-xl text-gray-500 hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-40 transition-colors"
          >
            <ChevronRight size={20} />
          </button>
        </div>
        {!isCurrentWeek && (
          <button type="button" onClick={() => loadWeek()} disabled={busy} className="block mx-auto mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-40">
            Back to this week
          </button>
        )}
      </nav>

      {pageError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600">
          <p>{pageError}</p>
          <button type="button" onClick={() => loadWeek(weekStart)} disabled={busy} className="mt-2 font-semibold underline disabled:opacity-40">Reload this week</button>
        </div>
      )}

      <div className={`rounded-2xl p-5 text-white shadow-md ${isOver ? 'bg-red-500' : 'bg-indigo-600'}`}>
        <p className="text-sm font-medium opacity-80">Remaining — week of {dateLabel(weekStart)}</p>
        <p className="text-4xl font-bold mt-1 tabular-nums">{formatARS(available)}</p>
        <div className="mt-4">
          <div className="flex justify-between text-xs opacity-75 mb-1">
            <span>{formatARS(spent)} spent</span>
            <span>{formatARS(allowance)} budget</span>
          </div>
          <div className="w-full bg-white/30 rounded-full h-2">
            <div className={`h-2 rounded-full transition-all ${isOver ? 'bg-red-200' : 'bg-white'}`} style={{ width: `${pctUsed}%` }} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-gray-500">{monthLabel} so far</span>
          <span className={`text-sm font-semibold tabular-nums ${monthOver ? 'text-red-500' : 'text-gray-700'}`}>{formatARS(monthly.available)} left</span>
        </div>
        <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5">
          <div className={`h-1.5 rounded-full transition-all ${monthOver ? 'bg-red-400' : 'bg-indigo-500'}`} style={{ width: `${monthPctUsed}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-gray-400 tabular-nums">
          <span>{formatARS(monthly.spent)} spent</span>
          <span>{formatARS(monthly.allowance)} budget</span>
        </div>
      </div>

      {isOver && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-semibold text-red-700">Over budget {isCurrentWeek ? 'this' : 'for the selected'} week</p>
          <p className="text-xs text-red-500 mt-0.5">You've exceeded your weekly allowance by {formatARS(Math.abs(available))}.</p>
        </div>
      )}

      <form ref={formRef} onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
        <h2 className="font-semibold text-gray-700">{editingExpense ? 'Edit expense' : 'Add expense'}</h2>
        {!isCurrentWeek && <p className="text-xs text-gray-500">For the week of {dateLabel(weekStart)}</p>}
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              aria-label="Amount in ARS"
              placeholder="Amount in ARS"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full min-w-0 sm:flex-1 border border-gray-200 rounded-xl px-4 py-3 text-gray-800 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <select
              aria-label="Category"
              value={categoryId ?? ''}
              onChange={e => setCategoryId(e.target.value ? Number(e.target.value) : null)}
              disabled={categories.length === 0}
              className="w-full sm:w-auto border border-gray-200 rounded-xl px-3 py-3 text-gray-800 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
            >
              {editingExpense && !categories.some(c => c.name === editingExpense.category) && <option value="">{editingExpense.category} (saved category)</option>}
              {!editingExpense && categories.length === 0 && <option value="">No categories</option>}
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <input type="text" aria-label="Description" placeholder="Description (optional)" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-gray-200 rounded-xl px-4 py-3 text-gray-800 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          <div>
            <label htmlFor="expense-date" className="block text-xs font-medium text-gray-600 mb-1">Expense date</label>
            <input id="expense-date" type="date" required min={weekStart} max={maxDate} value={date} onChange={e => setDate(e.target.value)} className="w-full min-w-0 border border-gray-200 rounded-xl px-4 py-3 text-gray-800 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>
          {error && <p role="alert" className="text-red-500 text-xs">{error}</p>}
          <div className="flex gap-2">
            {editingExpense && <button type="button" onClick={() => resetForm()} className="rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>}
            <button type="submit" disabled={!editingExpense && categories.length === 0} className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 text-sm transition-colors">
              {submitting ? 'Saving…' : editingExpense ? 'Save changes' : 'Add Expense'}
            </button>
          </div>
        </fieldset>
      </form>

      {expenses.length > 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          <h2 className="font-semibold text-gray-700 px-5 py-4">{isCurrentWeek ? 'This week' : `Week of ${dateLabel(weekStart)}`}</h2>
          {expenses.map(expense => {
            const match = categories.find(c => c.name === expense.category)
            return (
              <div key={expense.id} className="flex flex-wrap items-center justify-between px-5 py-3 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium px-2 py-1 rounded-lg truncate text-white" style={match ? { backgroundColor: match.color } : { backgroundColor: '#e5e7eb', color: '#4b5563' }}>{expense.category}</span>
                    <span className="text-xs text-gray-400 shrink-0">{new Date(expense.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </div>
                  <p className="text-sm text-gray-500 truncate mt-1">{expense.description || '—'}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-sm font-semibold text-gray-800 mr-1">{formatARS(expense.amount)}</span>
                  <button type="button" onClick={() => startEditing(expense)} disabled={busy} className="p-2 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 transition-colors" aria-label={`Edit expense${expense.description ? `: ${expense.description}` : ''}`}><Pencil size={16} /></button>
                  <button type="button" onClick={() => handleDelete(expense.id)} disabled={busy} className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-50 disabled:opacity-40 transition-colors" aria-label={`Delete expense${expense.description ? `: ${expense.description}` : ''}`}><Trash2 size={16} /></button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-center text-sm text-gray-400 py-4">No expenses logged {isCurrentWeek ? 'this' : 'for the selected'} week.</p>
      )}
    </div>
  )
}
