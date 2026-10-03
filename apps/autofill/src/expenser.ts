import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { env } from './env.js'
import type { ExpenseSink, ExtractedExpense } from './types.js'

/**
 * Drives the real Expenser webapp: logs in (reusing a saved session when possible) and fills
 * the "Add expense" form on the home page, exactly like a person would. Used when no
 * EXPENSER_API_KEY is configured.
 */
export class ExpenserBot implements ExpenseSink {
  private browser!: Browser
  private context!: BrowserContext
  private page!: Page

  static async open(): Promise<ExpenserBot> {
    const bot = new ExpenserBot()
    bot.browser = await chromium.launch({
      headless: env.headless,
      executablePath: env.browserExecutablePath,
    })
    bot.context = await bot.browser.newContext({
      storageState: existsSync(env.authStatePath) ? env.authStatePath : undefined,
    })
    bot.page = await bot.context.newPage()
    await bot.goHome()
    return bot
  }

  async close(): Promise<void> {
    await this.browser.close()
  }

  /** Category names as shown in the form's <select>, in display order. */
  async getCategories(): Promise<string[]> {
    const names = await this.categorySelect.locator('option').allTextContents()
    const categories = names.map(n => n.trim()).filter(n => n && n !== 'No categories')
    if (categories.length === 0) throw new Error('The Expenser account has no categories')
    return categories
  }

  async addExpense(expense: ExtractedExpense): Promise<void> {
    const submit = this.form.getByRole('button', { name: 'Add Expense' })
    await submit.waitFor()

    await this.amountInput.fill(String(expense.amount))
    await this.categorySelect.selectOption({ label: expense.category })
    await this.descriptionInput.fill(expense.description)

    const created = this.page.waitForResponse(
      res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/expenses',
    )
    await submit.click()
    const res = await created
    if (res.status() !== 201) {
      throw new Error(`POST /expenses returned ${res.status()}: ${await res.text().catch(() => '')}`)
    }

    // The form clears the amount once the expense is saved; wait so the next fill starts clean.
    await this.amountInput.and(this.page.locator('input:placeholder-shown')).waitFor()
  }

  private get form(): Locator {
    return this.page.locator('form').filter({ has: this.page.getByRole('heading', { name: 'Add expense' }) })
  }

  private get amountInput(): Locator {
    return this.form.getByPlaceholder('Amount in ARS')
  }

  private get descriptionInput(): Locator {
    return this.form.getByPlaceholder('Description (optional)')
  }

  private get categorySelect(): Locator {
    return this.form.locator('select')
  }

  /** Lands on the home page with the expense form ready, logging in first if needed. */
  private async goHome(): Promise<void> {
    await this.page.goto(`${env.expenserUrl}/`)

    // Either the form renders (session still valid) or the app redirects to /login.
    const loginEmail = this.page.locator('#email')
    await this.amountInput.or(loginEmail).first().waitFor({ timeout: 30_000 })
    if (!(await loginEmail.isVisible())) return

    await loginEmail.fill(env.expenserEmail)
    await this.page.locator('#password').fill(env.expenserPassword)
    await this.page.getByRole('button', { name: 'Log in' }).click()

    const loginError = this.page.locator('form p.text-red-600')
    await this.amountInput.or(loginError).first().waitFor({ timeout: 30_000 })
    if (await loginError.isVisible()) {
      throw new Error(`Expenser login failed: ${(await loginError.textContent())?.trim()}`)
    }

    await mkdir(dirname(env.authStatePath), { recursive: true })
    await this.context.storageState({ path: env.authStatePath })
    console.log('[expenser] logged in, session saved')
  }
}
