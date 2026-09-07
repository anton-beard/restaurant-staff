import type { Api } from 'grammy'
import type { Db } from './db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from './db/settings.js'

export async function notifyOwner(api: Api, db: Db, text: string): Promise<boolean> {
  const ownerId = getSetting(db, OWNER_TELEGRAM_ID)
  if (!ownerId) return false
  try {
    await api.sendMessage(Number(ownerId), text)
    return true
  } catch (err) {
    console.error('notifyOwner failed', err)
    return false
  }
}
