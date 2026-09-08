import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  BOT_TOKEN: 't',
  OWNER_PHONE: '+79990000000',
  SESSION_SECRET: 'sixteen-characters!',
  ANTHROPIC_API_KEY: 'k',
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base)
    expect(c.DATA_DIR).toBe('/data')
    expect(c.PORT).toBe(3000)
    expect(c.PUBLIC_URL).toBeUndefined()
  })

  it('coerces PORT and keeps optional values', () => {
    const c = loadConfig({ ...base, PORT: '8080', PUBLIC_URL: 'https://x.y' })
    expect(c.PORT).toBe(8080)
    expect(c.PUBLIC_URL).toBe('https://x.y')
  })

  it('throws on missing BOT_TOKEN', () => {
    expect(() => loadConfig({ ...base, BOT_TOKEN: '' })).toThrow(/BOT_TOKEN/)
  })

  it('defaults AI_MODEL and TZ, requires ANTHROPIC_API_KEY', () => {
    const c = loadConfig(base)
    expect(c.AI_MODEL).toBe('claude-sonnet-5')
    expect(c.TZ).toBe('Europe/Moscow')
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: '' })).toThrow(/ANTHROPIC_API_KEY/)
  })
})
