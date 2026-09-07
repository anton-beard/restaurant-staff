import type { z } from 'zod'

export class ValidationError extends Error {
  constructor(public issues: unknown) {
    super('validation')
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new ValidationError(result.error.issues)
  return result.data
}
