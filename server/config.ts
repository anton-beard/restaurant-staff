import { z } from 'zod'

const schema = z.object({
  BOT_TOKEN: z.string().min(1),
  OWNER_PHONE: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  ANTHROPIC_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1).default('claude-sonnet-5'),
  TZ: z.string().min(1).default('Europe/Moscow'),
  DATA_DIR: z.string().min(1).default('/data'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  )
  const result = schema.safeParse(cleaned)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid config: ${fields}`)
  }
  return result.data
}
