import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { env } from './env.js'
import { ExpenserBot } from './expenser.js'
import { extractExpenses, SUPPORTED_EXTENSIONS } from './gemini.js'
import { Ledger } from './ledger.js'
import type { Extraction } from './types.js'

export function isImage(path: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase())
}

export async function listInbox(): Promise<string[]> {
  const entries = await readdir(env.inboxDir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && isImage(e.name))
    .map(e => join(env.inboxDir, e.name))
    .sort()
}

/**
 * Processes a batch of images with one browser session: extract each with Gemini, add the
 * expenses through the webapp, then move the image to processed/ or failed/ with a JSON report.
 */
export async function processImages(images: string[], { dryRun = false } = {}): Promise<void> {
  if (images.length === 0) return
  await Promise.all([env.processedDir, env.failedDir].map(d => mkdir(d, { recursive: true })))

  const ledger = await Ledger.load()
  const bot = await ExpenserBot.open()
  try {
    const categories = await bot.getCategories()
    console.log(`[expenser] categories: ${categories.join(', ')}`)

    for (const image of images) {
      await processImage(bot, ledger, image, categories, dryRun)
    }
  } finally {
    await bot.close()
  }
}

async function processImage(
  bot: ExpenserBot,
  ledger: Ledger,
  image: string,
  categories: string[],
  dryRun: boolean,
) {
  const name = basename(image)
  let extraction: Extraction | undefined
  let added = 0
  let skipped = 0

  try {
    console.log(`\n[${name}] extracting with ${env.geminiModel}…`)
    extraction = await extractExpenses(image, categories)
    if (extraction.notes) console.log(`[${name}] notes: ${extraction.notes}`)

    const keys = Ledger.keysFor(extraction.expenses)
    console.table(
      extraction.expenses.map((e, i) => ({ ...e, status: ledger.has(keys[i]) ? 'already added' : 'new' })),
    )

    if (extraction.expenses.length === 0) throw new Error('No expenses found in image')
    if (dryRun) {
      console.log(`[${name}] dry run — nothing added, image left in inbox`)
      return
    }

    for (const [i, expense] of extraction.expenses.entries()) {
      if (ledger.has(keys[i])) {
        skipped++
        continue
      }
      await bot.addExpense(expense)
      await ledger.add(keys[i], expense, name)
      added++
      console.log(`[${name}] ✓ added ${expense.amount} ARS · ${expense.category} · ${expense.description}`)
    }

    await archive(image, env.processedDir, { extraction, added, skipped })
    console.log(`[${name}] done — ${added} added, ${skipped} already added before`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${name}] ✗ ${message}`)
    if (dryRun) return
    // Expenses added before the error are in the ledger, so moving the image back to the inbox is safe.
    await archive(image, env.failedDir, { error: message, extraction, added, skipped })
  }
}

/** Moves the image into `dir` (timestamp-prefixed to avoid clashes) with a sidecar JSON report. */
async function archive(image: string, dir: string, report: object): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `${stamp}_${basename(image)}`)
  await rename(image, target)
  await writeFile(`${target}.json`, JSON.stringify({ source: basename(image), ...report }, null, 2) + '\n')
}
