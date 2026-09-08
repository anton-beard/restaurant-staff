import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Api } from 'grammy'
import type { Db } from '../db/connect.js'
import { createTelegramNotifier } from '../notify.js'
import { createBot } from '../bot/createBot.js'
import type { BotDeps } from '../bot/deps.js'
import { botInfo, captureApi, type ApiCall } from './telegram.js'

export const OWNER_PHONE = '+79990000000'

export function makeBot(
  db: Db,
  overrides: Partial<BotDeps> = {},
  responders: Record<string, (p: Record<string, unknown>) => unknown> = {},
) {
  const calls: ApiCall[] = []
  const api = new Api('test')
  captureApi(api, responders, calls)
  const notifier = createTelegramNotifier(api, db)
  const deps: BotDeps = {
    db,
    ownerPhone: OWNER_PHONE,
    publicUrl: 'https://admin.example',
    notifier,
    tz: 'Europe/Moscow',
    uploadsDir: mkdtempSync(join(tmpdir(), 'bot-uploads-')),
    downloadFile: async () => Buffer.from('fake-jpeg'),
    onSubmission: () => undefined,
    now: () => new Date('2026-09-07T19:00:00.000Z'),
    ...overrides,
  }
  const bot = createBot({ token: 'test', botInfo, deps })
  captureApi(bot, responders, calls)
  return { bot, calls, notifier, deps }
}
