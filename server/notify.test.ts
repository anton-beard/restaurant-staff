import { Api } from 'grammy'
import { describe, expect, it } from 'vitest'
import { openDb } from './db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from './db/settings.js'
import { notifyOwner } from './notify.js'

function fakeApi(fail = false) {
  const api = new Api('test')
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (fail) return { ok: false, error_code: 403, description: 'blocked' }
    return { ok: true, result: true }
  })
  return { api, calls }
}

describe('notifyOwner', () => {
  it('returns false when the owner is not linked', async () => {
    const db = openDb(':memory:')
    const { api, calls } = fakeApi()
    expect(await notifyOwner(api, db, 'hi')).toBe(false)
    expect(calls).toEqual([])
  })

  it('sends a message to the owner chat', async () => {
    const db = openDb(':memory:')
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const { api, calls } = fakeApi()
    expect(await notifyOwner(api, db, 'hi')).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'sendMessage', payload: { chat_id: 42, text: 'hi' } })
  })

  it('returns false when telegram fails', async () => {
    const db = openDb(':memory:')
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const { api } = fakeApi(true)
    expect(await notifyOwner(api, db, 'hi')).toBe(false)
  })
})
