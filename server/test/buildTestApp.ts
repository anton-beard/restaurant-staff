import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { openDb } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'

export async function buildTestApp() {
  const db = openDb(':memory:')
  const config = loadConfig({
    BOT_TOKEN: 't',
    OWNER_PHONE: '+79990000000',
    SESSION_SECRET: 'sixteen-characters!',
  })
  const sent: string[] = []
  const auth = createOwnerAuth(db)
  const app = buildApp({
    config,
    db,
    auth,
    sendToOwner: async (text) => {
      sent.push(text)
      return true
    },
  })
  await app.ready()

  async function loginAsOwner(): Promise<string> {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    const code = sent.at(-1)!.match(/\d{6}/)![0]
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    const c = res.cookies[0]!
    return `${c.name}=${c.value}`
  }

  return { app, db, sent, loginAsOwner }
}
