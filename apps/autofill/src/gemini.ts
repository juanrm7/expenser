import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { GoogleGenAI, Type } from '@google/genai'
import { env } from './env.js'
import type { Extraction } from './types.js'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

export const SUPPORTED_EXTENSIONS = Object.keys(MIME_TYPES)

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey })

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    expenses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          amount: { type: Type.NUMBER, description: 'Amount in ARS as a plain number, e.g. 12345.5' },
          description: { type: Type.STRING, description: 'Short description, max ~60 chars' },
          category: { type: Type.STRING, description: 'Exactly one of the allowed category names' },
          date: { type: Type.STRING, description: 'YYYY-MM-DD, or "" if no date is visible' },
          merchant: { type: Type.STRING, description: 'Merchant/transaction text verbatim as printed' },
        },
        required: ['merchant', 'date', 'amount', 'description', 'category'],
        propertyOrdering: ['merchant', 'date', 'amount', 'description', 'category'],
      },
    },
    notes: { type: Type.STRING },
  },
  required: ['expenses', 'notes'],
  propertyOrdering: ['expenses', 'notes'],
}

function buildPrompt(categories: string[]): string {
  const today = new Date().toLocaleDateString('en-CA') // local YYYY-MM-DD
  return `You extract personal expenses from an image so they can be logged in an expense tracker.
The image may be a store receipt, an invoice, a credit card / bank / Mercado Pago transaction list
(e.g. Naranja X "Tus consumos"), or a handwritten note. Amounts are in Argentine Pesos (ARS).
Today is ${today}.

Rules:
- Return one expense per distinct payment/transaction. For a single receipt, return ONE expense
  with the final total actually paid (after discounts, including taxes/tip) — not each line item.
  For a transaction list, return one expense per outgoing transaction, in the order shown.
- Include transactions marked pending ("Pendiente de autorización", "En proceso") — they are real
  purchases. Ignore incoming money, refunds, reversals ("Anulado"), balances, and card payments.
- Only include rows whose amount is fully visible. Skip rows cut off at the top or bottom edge.
- Argentine number format uses "." for thousands and "," for decimals: "$ 12.345,50" is 12345.5.
  Return amount as a plain positive number.
- merchant: the transaction text exactly as printed, character for character (e.g. "Merpago coto").
- date: the transaction date as YYYY-MM-DD ("3/OCT/26" is 2026-10-03; a date without a year is the
  most recent such date on or before today). Use "" if the image shows no date.
- description: a clean, short name for the purchase. Drop payment-processor prefixes such as
  "Merpago", "MERPAGO*", "MP *", "PAYU*", "DLO*" and fix capitalisation: "Merpago coto" -> "Coto",
  "Franco specialty coffe" -> "Franco Specialty Coffee". Add what was bought only if the image says.
- category: pick the best fit from EXACTLY this list (copy the name verbatim):
  ${categories.map(c => JSON.stringify(c)).join(', ')}
  Supermarkets, cafés, restaurants and food delivery are food. Payments to what looks like a
  person's name (e.g. "christianjesuslop") are unknown — use the catch-all category if there is one.
- If nothing in the image is an expense, return an empty list and explain why in notes.
- Use notes for anything uncertain (blurry digits, guessed category, etc.); otherwise "".`
}

export async function extractExpenses(imagePath: string, categories: string[]): Promise<Extraction> {
  const mimeType = MIME_TYPES[extname(imagePath).toLowerCase()]
  if (!mimeType) throw new Error(`Unsupported image type: ${imagePath}`)

  const data = (await readFile(imagePath)).toString('base64')

  const response = await ai.models.generateContent({
    model: env.geminiModel,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data } }, { text: buildPrompt(categories) }],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0,
    },
  })

  if (!response.text) throw new Error('Gemini returned an empty response')
  const parsed = JSON.parse(response.text) as Extraction

  return {
    notes: parsed.notes ?? '',
    expenses: (parsed.expenses ?? [])
      .filter(e => Number.isFinite(e.amount) && e.amount > 0)
      .map(e => ({
        amount: Math.round(e.amount * 100) / 100,
        description: e.description.trim(),
        category: matchCategory(e.category, categories),
        date: /^\d{4}-\d{2}-\d{2}$/.test(e.date ?? '') ? e.date : '',
        merchant: (e.merchant ?? '').trim(),
      })),
  }
}

/** Snap the model's category to a real one (case-insensitive), falling back to "Other" or the first. */
function matchCategory(name: string, categories: string[]): string {
  const exact = categories.find(c => c.toLowerCase() === name.trim().toLowerCase())
  if (exact) return exact
  return categories.find(c => c.toLowerCase() === 'other') ?? categories[0]
}
