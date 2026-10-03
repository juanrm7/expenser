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
        },
        required: ['amount', 'description', 'category'],
        propertyOrdering: ['amount', 'description', 'category'],
      },
    },
    notes: { type: Type.STRING },
  },
  required: ['expenses', 'notes'],
  propertyOrdering: ['expenses', 'notes'],
}

function buildPrompt(categories: string[]): string {
  return `You extract personal expenses from an image so they can be logged in an expense tracker.
The image may be a store receipt, an invoice, a bank/Mercado Pago/card transaction screenshot,
a list of purchases, or a handwritten note. Amounts are in Argentine Pesos (ARS).

Rules:
- Return one expense per distinct payment/transaction. For a single receipt, return ONE expense
  with the final total actually paid (after discounts, including taxes/tip) — not each line item.
  For a screenshot listing several transactions, return one expense per outgoing transaction.
- Ignore incoming money, refunds, balances, and transfers between the user's own accounts.
- Argentine number format uses "." for thousands and "," for decimals: "$ 12.345,50" is 12345.5.
  Return amount as a plain positive number.
- description: short and useful, e.g. the merchant name plus what was bought ("Coto - groceries",
  "Uber to airport"). Write it in the same language as the image.
- category: pick the best fit from EXACTLY this list (copy the name verbatim):
  ${categories.map(c => JSON.stringify(c)).join(', ')}
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
      })),
  }
}

/** Snap the model's category to a real one (case-insensitive), falling back to "Other" or the first. */
function matchCategory(name: string, categories: string[]): string {
  const exact = categories.find(c => c.toLowerCase() === name.trim().toLowerCase())
  if (exact) return exact
  return categories.find(c => c.toLowerCase() === 'other') ?? categories[0]
}
