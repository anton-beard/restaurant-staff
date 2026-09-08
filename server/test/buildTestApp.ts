import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { openDb } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'
import type { Notifier } from '../notify.js'

export type Notification = { to: 'owner' | number; text: string }

export function fakeNotifier(log: Notification[]): Notifier {
  return {
    async toOwner(text) {
      log.push({ to: 'owner', text })
      return log.length
    },
    async toEmployee(telegramId, text) {
      log.push({ to: telegramId, text })
      return log.length
    },
    async photosToOwner(_paths, caption) {
      log.push({ to: 'owner', text: caption })
      return true
    },
    async editMessage() {
      return true
    },
  }
}

export const testEnv = {
  BOT_TOKEN: 't',
  OWNER_PHONE: '+79990000000',
  SESSION_SECRET: 'sixteen-characters!',
  ANTHROPIC_API_KEY: 'k',
}

export async function buildTestApp() {
  const db = openDb(':memory:')
  const config = loadConfig(testEnv)
  const notifications: Notification[] = []
  const sent: string[] = []
  const base = fakeNotifier(notifications)
  const notifier: Notifier = {
    ...base,
    toOwner: (text, extra) => {
      sent.push(text)
      return base.toOwner(text, extra)
    },
  }
  const auth = createOwnerAuth(db)
  const uploadsDir = mkdtempSync(join(tmpdir(), 'uploads-'))
  const app = buildApp({ config, db, auth, notifier, uploadsDir })
  await app.ready()

  async function loginAsOwner(): Promise<string> {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    const code = notifications.at(-1)!.text.match(/\d{6}/)![0]
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    const c = res.cookies[0]!
    return `${c.name}=${c.value}`
  }

  return { app, db, sent, notifications, loginAsOwner, uploadsDir }
}
