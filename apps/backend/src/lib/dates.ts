// Calendar logic, in the server's local time zone (`TZ`). Weeks run Saturday through Friday.
//
// A calendar date is a `YYYY-MM-DD` string in the API, and the `Date` of its local midnight here.

/** The local midnight of a strict `YYYY-MM-DD` calendar date, or null if it isn't one. */
export function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00`)
  // Rolled-over dates like 2026-02-30 format differently.
  return Number.isFinite(date.getTime()) && formatDate(date) === value ? date : null
}

/** The local calendar date (`YYYY-MM-DD`) of an instant. */
export function formatDate(instant: Date): string {
  const year = String(instant.getFullYear()).padStart(4, '0')
  const month = String(instant.getMonth() + 1).padStart(2, '0')
  const day = String(instant.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The instant the local day of `instant` begins. */
export function startOfDay(instant: Date): Date {
  const start = new Date(instant)
  start.setHours(0, 0, 0, 0)
  return start
}

/** The start of the local day `days` calendar days after the day of `instant`. */
export function addDays(instant: Date, days: number): Date {
  const date = startOfDay(instant)
  date.setDate(date.getDate() + days)
  // Where a DST jump skips midnight a day starts at 1:00; don't carry that hour to other days.
  return startOfDay(date)
}

/** The start of the Saturday the week of `instant` starts on. */
export function weekStart(instant: Date): Date {
  return addDays(instant, -((instant.getDay() + 1) % 7))
}

/** The start of the first day of the month of `instant`. */
export function monthStart(instant: Date): Date {
  return addDays(instant, 1 - instant.getDate())
}

/** The number of days in the month of `instant`. */
export function daysInMonth(instant: Date): number {
  return new Date(instant.getFullYear(), instant.getMonth() + 1, 0).getDate()
}
