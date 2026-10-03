import { mkdir } from 'node:fs/promises'
import { watch } from 'chokidar'
import { env } from './env.js'
import { isImage, listInbox, processImages } from './pipeline.js'

const [mode = 'watch', ...flags] = process.argv.slice(2)
const dryRun = flags.includes('--dry-run')

await mkdir(env.inboxDir, { recursive: true })

if (mode === 'once') {
  const images = await listInbox()
  if (images.length === 0) console.log(`Inbox is empty: ${env.inboxDir}`)
  try {
    await processImages(images, { dryRun })
  } catch (err) {
    // Batch-level failure (bad key/login, backend down): images stay in the inbox.
    console.error('[autofill] failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
} else if (mode === 'watch') {
  startWatching()
} else {
  console.error(`Unknown mode "${mode}". Use "watch" or "once [--dry-run]".`)
  process.exit(1)
}

function startWatching() {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let running = false

  // Batch images that arrive together (e.g. several screenshots dropped at once) so they
  // share one browser session, and never run two batches at the same time.
  async function flush() {
    if (running || pending.size === 0) return
    running = true
    const batch = [...pending].sort()
    pending.clear()
    try {
      await processImages(batch, { dryRun })
    } catch (err) {
      // Batch-level failure (browser/login/network): images stay in the inbox for a restart or `pnpm once`.
      console.error('[autofill] batch failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
      if (pending.size > 0) schedule()
    }
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(flush, 2_000)
  }

  watch(env.inboxDir, {
    depth: 0,
    // Wait for the file to stop growing (AirDrop, Syncthing, slow copies) before reading it.
    awaitWriteFinish: { stabilityThreshold: 1_000, pollInterval: 200 },
  }).on('add', path => {
    if (!isImage(path)) return
    pending.add(path)
    schedule()
  })

  console.log(`[autofill] watching ${env.inboxDir} — drop receipt images here (Ctrl+C to stop)`)
}
