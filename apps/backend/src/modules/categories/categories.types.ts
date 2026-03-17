export interface Category {
  id: number
  name: string
  color: string
}

export type CreateCategoryBody = Omit<Category, 'id'>
export type UpdateCategoryBody = Partial<CreateCategoryBody>
