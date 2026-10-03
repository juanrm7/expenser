import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { env } from './env.js'
import { ExpenserBot } from './expenser.js'
import { extractExpenses, SUPPORTED_EXTENSIONS } from './gemini.js'
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

  const bot = await ExpenserBot.open()
  try {
    const categories = await bot.getCategories()
    console.log(`[expenser] categories: ${categories.join(', ')}`)

    for (const image of images) {
      await processImage(bot, image, categories, dryRun)
    }
  } finally {
    await bot.close()
  }
}

async function processImage(bot: ExpenserBot, image: string, categories: string[], dryRun: boolean) {
  const name = basename(image)
  let extraction: Extraction | undefined
  let added = 0

  try {
    console.log(`\n[${name}] extracting with ${env.geminiModel}…`)
    extraction = await extractExpenses(image, categories)
    if (extraction.notes) console.log(`[${name}] notes: ${extraction.notes}`)
    console.table(extraction.expenses)

    if (extraction.expenses.length === 0) throw new Error('No expenses found in image')
    if (dryRun) {
      console.log(`[${name}] dry run — nothing added, image left in inbox`)
      return
    }

    for (const expense of extraction.expenses) {
      await bot.addExpense(expense)
      added++
      console.log(`[${name}] ✓ added ${expense.amount} ARS · ${expense.category} · ${expense.description}`)
    }

    await archive(image, env.processedDir, { extraction, added })
    console.log(`[${name}] done (${added} expense${added === 1 ? '' : 's'})`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${name}] ✗ ${message}`)
    if (dryRun) return
    // `added` tells you which expenses already went in, so a retry doesn't double-log them.
    await archive(image, env.failedDir, { error: message, extraction, added })
  }
}

/** Moves the image into `dir` (timestamp-prefixed to avoid clashes) with a sidecar JSON report. */
async function archive(image: string, dir: string, report: object): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `${stamp}_${basename(image)}`)
  await rename(image, target)
  await writeFile(`${target}.json`, JSON.stringify({ source: basename(image), ...report }, null, 2) + '\n')
}
