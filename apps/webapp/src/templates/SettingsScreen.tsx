import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppConfig } from '../lib/data'
import { formatARS, randomHexColor } from '../lib/data'
import { createCategory, deleteCategory, type Category } from '../services/categories'

interface Props {
  config: AppConfig
  onChange: (config: AppConfig) => void
  categories: Category[]
  onCategoryAdded: (category: Category) => void
  onCategoryRemoved: (id: number) => void
}

export function SettingsScreen({ config, onChange, categories, onCategoryAdded, onCategoryRemoved }: Props) {
  const [allowanceInput, setAllowanceInput] = useState(String(config.baseAllowance))
  const [allowanceSaved, setAllowanceSaved] = useState(false)
  const [categoryInput, setCategoryInput] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function saveAllowance(e: React.SyntheticEvent) {
    e.preventDefault()
    const val = parseFloat(allowanceInput.replace(',', '.'))
    if (!val || val <= 0) return
    onChange({ ...config, baseAllowance: val })
    setAllowanceSaved(true)
    setTimeout(() => setAllowanceSaved(false), 2000)
  }

  async function addCategory(e: React.SyntheticEvent) {
    e.preventDefault()
    const name = categoryInput.trim()
    if (!name) return
    if (categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      setCategoryError('Category already exists')
      return
    }
    setCategoryError('')
    setSubmitting(true)
    try {
      const color = randomHexColor(categories.map(c => c.color))
      const created = await createCategory(name, color)
      onCategoryAdded(created)
      setCategoryInput('')
    } catch (err) {
      console.error('Failed to create category:', err)
      setCategoryError('Failed to create category')
    } finally {
      setSubmitting(false)
    }
  }

  async function removeCategory(id: number) {
    try {
      await deleteCategory(id)
      onCategoryRemoved(id)
    } catch (err) {
      console.error('Failed to delete category:', err)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-6">

      {/* Allowance */}
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
        <div>
          <h2 className="font-semibold text-gray-800">Weekly allowance</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Carry-over from previous weeks is applied on top of this amount.
          </p>
        </div>
        <form onSubmit={saveAllowance} className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={allowanceInput}
            onChange={e => setAllowanceInput(e.target.value)}
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            placeholder="Amount in ARS"
          />
          <button
            type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
          >
            {allowanceSaved ? 'Saved!' : 'Save'}
          </button>
        </form>
        <p className="text-xs text-gray-400">
          Current: <span className="font-medium text-gray-600">{formatARS(config.baseAllowance)}</span> / week
        </p>
      </section>

      {/* Categories */}
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-gray-800">Categories</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Colors are assigned automatically.
          </p>
        </div>

        <form onSubmit={addCategory} className="flex gap-2">
          <input
            type="text"
            value={categoryInput}
            onChange={e => { setCategoryInput(e.target.value); setCategoryError('') }}
            placeholder="New category name"
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            type="submit"
            disabled={submitting}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
          >
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </form>
        {categoryError && <p className="text-red-500 text-xs">{categoryError}</p>}

        <ul className="space-y-2">
          {categories.map(cat => (
            <li key={cat.id} className="flex items-center justify-between">
              <span
                className="text-xs font-medium px-3 py-1.5 rounded-lg text-white"
                style={{ backgroundColor: cat.color }}
              >
                {cat.name}
              </span>
              <button
                onClick={() => removeCategory(cat.id)}
                className="p-1.5 text-gray-300 hover:text-red-400 transition-colors rounded-lg hover:bg-red-50"
                aria-label={`Remove ${cat.name}`}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
          {categories.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-2">No categories yet.</p>
          )}
        </ul>
      </section>

    </div>
  )
}
