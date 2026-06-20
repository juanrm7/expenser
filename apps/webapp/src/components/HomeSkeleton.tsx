export function HeaderSkeleton() {
  return (
    <header className="flex items-center justify-between px-4 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
      <h1 className="text-lg font-bold text-gray-900 tracking-tight">Expenser</h1>
      <div className="flex items-center gap-2">
        <span className="h-9 w-9 rounded-xl bg-gray-100 animate-pulse" />
        <span className="h-9 w-9 rounded-xl bg-gray-100 animate-pulse" />
      </div>
    </header>
  )
}

export function HomeSkeleton() {
  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      {/* Balance card placeholder */}
      <div className="rounded-2xl p-5 bg-indigo-600 shadow-md">
        <div className="h-4 w-40 rounded bg-white/30 animate-pulse" />
        <div className="h-10 w-48 rounded bg-white/40 animate-pulse mt-2" />
        <div className="mt-5 h-2 w-full rounded-full bg-white/30 animate-pulse" />
      </div>

      {/* Add-expense form placeholder */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
        <div className="h-5 w-28 rounded bg-gray-100 animate-pulse" />
        <div className="h-11 w-full rounded-xl bg-gray-100 animate-pulse" />
        <div className="h-11 w-full rounded-xl bg-gray-100 animate-pulse" />
        <div className="h-11 w-full rounded-xl bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
