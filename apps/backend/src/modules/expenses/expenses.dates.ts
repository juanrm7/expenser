export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isFinite(date.getTime()) && formatDate(date) === value ? date : null
}

export function getWeekStart(date = new Date()): Date {
  const start = new Date(date)
  start.setDate(start.getDate() - ((start.getDay() + 1) % 7))
  start.setHours(0, 0, 0, 0)
  return start
}
