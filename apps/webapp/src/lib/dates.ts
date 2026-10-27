export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00`)
  shifted.setDate(shifted.getDate() + days)
  return formatDate(shifted)
}

export function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** An instant (ISO timestamp) as a local date, e.g. "Oct 22, 2026". */
export function instantLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** When something (an API key, a connected app) was last used, e.g. "Used 5m ago". */
export function lastUsedLabel(iso: string | null): string {
  if (!iso) return 'Never used'
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'Used just now'
  if (minutes < 60) return `Used ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Used ${hours}h ago`
  return `Used ${instantLabel(iso)}`
}
