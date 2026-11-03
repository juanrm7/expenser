// Per-user expense categories.

import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { one } from '../../db/index.js'
import { categories } from '../../db/schema.js'
import { AppError, given } from '../../lib/errors.js'

export type Category = typeof categories.$inferSelect

const notFound = () => AppError.notFound('Category not found')

/** The user's categories, oldest first. */
export function listCategories(ctx: Context, userId: number): Promise<Category[]> {
  return ctx.db.select().from(categories).where(eq(categories.userId, userId)).orderBy(asc(categories.id))
}

/** The user's category with this id, if there is one. */
export async function findCategory(ctx: Context, userId: number, id: number): Promise<Category | undefined> {
  const [category] = await ctx.db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
  return category
}

export async function getCategory(ctx: Context, userId: number, id: number): Promise<Category> {
  const category = await findCategory(ctx, userId, id)
  if (!category) throw notFound()
  return category
}

export const createCategoryBody = z.object({ name: z.string(), color: z.string() })

export async function addCategory(
  ctx: Context,
  userId: number,
  body: z.output<typeof createCategoryBody>,
): Promise<Category> {
  return one(await ctx.db.insert(categories).values({ name: body.name, color: body.color, userId }).returning())
}

export const updateCategoryBody = z.object({ name: z.string().nullish(), color: z.string().nullish() })

/** Renames or recolors a category; omitted fields keep their value. */
export async function editCategory(
  ctx: Context,
  userId: number,
  id: number,
  body: z.output<typeof updateCategoryBody>,
): Promise<Category> {
  const changes = { name: given(body.name), color: given(body.color) }
  if (changes.name === undefined && changes.color === undefined) return getCategory(ctx, userId, id)
  const [category] = await ctx.db
    .update(categories)
    .set(changes)
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .returning()
  if (!category) throw notFound()
  return category
}

/** Deletes a category, returning it. Expenses keep its name, so deleting it doesn't touch them. */
export async function deleteCategory(ctx: Context, userId: number, id: number): Promise<Category> {
  const [category] = await ctx.db
    .delete(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, userId)))
    .returning()
  if (!category) throw notFound()
  return category
}
