import { Api, InlineKeyboard } from 'grammy'
import { describe, expect, it } from 'vitest'
import { openDb } from './db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from './db/settings.js'
import { createTelegramNotifier } from './notify.js'
import { captureApi } from './test/telegram.js'

function setup(ownerLinked = true) {
  const db = openDb(':memory:')
  if (ownerLinked) setSetting(db, OWNER_TELEGRAM_ID, '42')
  const api = new Api('test')
  const calls = captureApi(api)
  return { db, api, calls, notifier: createTelegramNotifier(api, db) }
}

describe('notifier', () => {
  it('toOwner returns null when the owner is not linked', async () => {
    const { notifier, calls } = setup(false)
    expect(await notifier.toOwner('hi')).toBeNull()
    expect(calls).toEqual([])
  })

  it('toOwner and toEmployee return the message id and pass the keyboard', async () => {
    const { notifier, calls } = setup()
    const kb = new InlineKeyboard().text('Ок', 'x')
    expect(await notifier.toOwner('hi', { keyboard: kb })).toBeTypeOf('number')
    expect(calls[0]).toMatchObject({ method: 'sendMessage', payload: { chat_id: 42, text: 'hi' } })
    expect(JSON.stringify(calls[0]!.payload.reply_markup)).toContain('"callback_data":"x"')
    expect(await notifier.toEmployee(500, 'yo')).toBeTypeOf('number')
    expect(calls[1]!.payload.chat_id).toBe(500)
  })

  it('returns null when telegram fails', async () => {
    const db = openDb(':memory:')
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const api = new Api('test')
    api.config.use(async () => ({ ok: false, error_code: 403, description: 'blocked' }))
    const notifier = createTelegramNotifier(api, db)
    expect(await notifier.toOwner('hi')).toBeNull()
    expect(await notifier.editMessage(42, 1, 'x')).toBe(false)
  })

  it('photosToOwner sends one photo with caption or a media group plus a message', async () => {
    const { notifier, calls } = setup()
    expect(await notifier.photosToOwner(['/tmp/a.jpg'], 'cap')).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'sendPhoto', payload: { chat_id: 42, caption: 'cap' } })
    calls.length = 0
    expect(await notifier.photosToOwner(['/tmp/a.jpg', '/tmp/b.jpg'], 'cap')).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage'])
  })
})
