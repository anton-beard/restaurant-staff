import { beforeEach, describe, expect, it } from 'vitest'
import { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { setState } from '../db/botStates.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { seedRestaurant } from '../test/fixtures.js'
import { botInfo, callbackUpdate, captureApi, textUpdate } from '../test/telegram.js'
import { createTelegramNotifier } from '../notify.js'
import { Api } from 'grammy'
import { onState, registerContextMiddleware, type BotContext } from './states.js'
import type { BotDeps } from './deps.js'

let db: Db
let bot: Bot<BotContext>
let seen: string[]

beforeEach(() => {
  db = openDb(':memory:')
  seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  seen = []
  bot = new Bot<BotContext>('test', { botInfo })
  captureApi(bot)
  const api = new Api('test')
  const deps = {
    db, ownerPhone: '+79990000000', notifier: createTelegramNotifier(api, db), tz: 'Europe/Moscow',
    uploadsDir: '/tmp', downloadFile: async () => Buffer.alloc(0), onSubmission: () => undefined, now: () => new Date(),
  } satisfies BotDeps
  registerContextMiddleware(bot, deps)
  onState(bot, 'collecting_photos', async (ctx) => { seen.push(`collecting:${ctx.state.instance_id}`) })
  onState(bot, 'quiz', async (ctx) => { seen.push(`quiz:${ctx.state.attempt_id}`) })
  bot.on('message', async (ctx) => { seen.push(`fallback:${ctx.role.kind}:${ctx.state?.kind ?? 'none'}`) })
  bot.on('callback_query', async (ctx) => { seen.push(`cb:${ctx.state?.kind ?? 'none'}`) })
})

describe('context middleware', () => {
  it('resolves role and state once per update', async () => {
    await bot.handleUpdate(textUpdate(500, 'hi'))
    await bot.handleUpdate(textUpdate(42, 'hi'))
    await bot.handleUpdate(textUpdate(999, 'hi'))
    expect(seen).toEqual(['fallback:employee:none', 'fallback:owner:none', 'fallback:unknown:none'])
  })

  it('dispatches messages to the handler of the current state only', async () => {
    setState(db, 500, { kind: 'collecting_photos', instance_id: 7, photos: [] })
    setState(db, 501, { kind: 'quiz', attempt_id: 3 })
    await bot.handleUpdate(textUpdate(500, 'x'))
    await bot.handleUpdate(textUpdate(501, 'x'))
    expect(seen).toEqual(['collecting:7', 'quiz:3'])
  })

  it('lets callback queries pass through state handlers', async () => {
    setState(db, 500, { kind: 'quiz', attempt_id: 3 })
    await bot.handleUpdate(callbackUpdate(500, 'anything'))
    expect(seen).toEqual(['cb:quiz'])
  })
})
