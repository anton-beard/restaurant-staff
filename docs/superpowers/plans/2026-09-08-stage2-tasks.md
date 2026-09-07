# Этап 2: задания, фото и проверка через Claude. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец создаёт шаблоны заданий, система выдаёт их сотрудникам в Telegram по расписанию или сразу, сотрудники отчитываются кнопкой или фото, фото оценивает Claude, спорные сдачи владелец решает в боте или в админке.

**Architecture:** Тот же один процесс. Новые слои: репозитории заданий поверх миграции `002_tasks`; чистые функции расписания на `Intl`; сервис выдачи, общий для API и планировщика; фоновая очередь проверки фото с состоянием в базе; планировщик с тиком раз в минуту; бот разбит на модули `linking` / `tasks` / `review`; единый `Notifier` вместо `sendToOwner`.

**Tech Stack:** как в этапе 1 плюс `@anthropic-ai/sdk` (структурированный вывод через `client.messages.parse` + `zodOutputFormat`).

Спек: `docs/superpowers/specs/2026-09-08-stage2-tasks-design.md`. Код этапа 1 в репозитории (`server/`, `admin/`), паттерны: `db` первым аргументом, zod через `parse()` из `server/lib/validate.ts`, тесты рядом с кодом, API-тесты через `buildTestApp`, бот-тесты через `bot.handleUpdate` и захват вызовов API.

## Global Constraints

- Node.js ≥ 24, ESM, TypeScript strict, `verbatimModuleSyntax` (type-only импорты через `import type`).
- Один процесс, SQLite, миграции в `server/db/migrations.ts` массивом; новая миграция `002_tasks`.
- Переменные окружения: `ANTHROPIC_API_KEY` обязательна, `AI_MODEL` по умолчанию `claude-sonnet-5`, `TZ` по умолчанию `Europe/Moscow`; остальные как в этапе 1.
- Статусы экземпляра: `open` | `pending` | `submitted` | `review` | `accepted` | `overdue`. Решения сдачи: `auto_accepted` | `needs_review` | `owner_accepted` | `owner_rejected`. Порог автоприёма по умолчанию 80, `score >= threshold` → автоприём, автоотказов нет.
- Фото: до 3 на сдачу, только тип `photo`, файлы в `DATA_DIR/uploads/<instance_id>/`, дубликат `file_unique_id` отклоняется. Хранение `photo_retention_days` (по умолчанию 90).
- Планировщик: пропущенный слот старше 60 минут не выдаётся; зависшая проверка ИИ перезапускается после 3 минут, максимум 3 попытки.
- Напоминание одно на экземпляр: за 2 часа до дедлайна при сроке > 4 часов, иначе за половину срока.
- Все `/api/` кроме входа и `/healthz` за сессией владельца, включая `/api/uploads/*`.
- Тексты бота и админки на русском.
- Коммиты от локального автора `anton-beard`, без remote и push, сообщения заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Не читать и не коммитить `.env`.

## Структура файлов

```
server/notify.ts                      Notifier (замена notifyOwner)
server/lib/time.ts                    localParts, zonedToUtc, formatLocal
server/tasks/schedule.ts              Schedule, scheduleSchema, slotsForDay, nextRun
server/tasks/issue.ts                 issueTemplate (each/shared) + уведомления
server/tasks/decide.ts                decideByScore, applyOwnerDecision
server/tasks/reviewQueue.ts           фоновая очередь проверки фото
server/ai/photoReview.ts              reviewPhotos через @anthropic-ai/sdk
server/db/migrations.ts               + 002_tasks
server/db/taskTemplates.ts            шаблоны и связи
server/db/taskInstances.ts            экземпляры, предложения, напоминания, просрочки
server/db/taskSubmissions.ts          сдачи и фото
server/db/botStates.ts                состояние диалога
server/api/tasks.ts                   /api/tasks/*
server/api/uploads.ts                 /api/uploads/* за сессией
server/bot/deps.ts                    BotDeps
server/bot/roles.ts                   roleOf, summaryText
server/bot/linking.ts                 привязка, меню, фолбэк (перенос)
server/bot/tasks.ts                   сотрудник: список, карточка, фото, «Беру»
server/bot/review.ts                  владелец: принять/отклонить, комментарий
server/bot/files.ts                   загрузка файла из Telegram
server/bot/callbacks.ts               кодирование callback_data
server/bot/keyboards.ts               + кнопки этапа 2
server/scheduler/tick.ts              createScheduler
server/scheduler/issueDue.ts          выдача регулярных
server/scheduler/reminders.ts
server/scheduler/overdue.ts
server/scheduler/retryReviews.ts
server/scheduler/cleanup.ts
server/test/bot.ts                    makeBot для тестов бота
server/test/telegram.ts               + photoUpdate, callbackUpdate, captureApi с ответами
server/test/fixtures.ts               seedRestaurant: должности и сотрудники
admin/src/api.ts                      + типы и методы заданий
admin/src/router.ts, components/AppLayout.vue   + пункты меню
admin/src/pages/TemplatesPage.vue, TemplateForm.vue, InstancesPage.vue, ReviewPage.vue
admin/src/lib/schedule.ts             описание расписания словами
```

---

### Task 1: Рефакторинг: Notifier, разбиение бота, конфиг

**Files:**
- Modify: `server/config.ts`, `server/config.test.ts`, `.env.example`
- Replace: `server/notify.ts`, `server/notify.test.ts`
- Create: `server/bot/deps.ts`, `server/bot/roles.ts`, `server/bot/linking.ts`, `server/test/bot.ts`
- Modify: `server/bot/createBot.ts` (становится сборкой), `server/bot/createBot.test.ts`, `server/test/telegram.ts`
- Modify: `server/app.ts`, `server/api/auth.ts`, `server/test/buildTestApp.ts`, `server/index.ts`
- Modify: `package.json` (зависимость `@anthropic-ai/sdk`)

**Interfaces:**
- Produces `Config` с новыми полями `ANTHROPIC_API_KEY: string`, `AI_MODEL: string`, `TZ: string`.
- Produces `Notifier` и `createTelegramNotifier(api: Api, db: Db): Notifier`:
  ```ts
  type SendExtra = { keyboard?: InlineKeyboard }
  type Notifier = {
    toOwner(text: string, extra?: SendExtra): Promise<number | null>          // message_id или null
    toEmployee(telegramId: number, text: string, extra?: SendExtra): Promise<number | null>
    photosToOwner(paths: string[], caption: string, keyboard?: InlineKeyboard): Promise<boolean>
    editMessage(chatId: number, messageId: number, text: string): Promise<boolean>
  }
  ```
- Produces `BotDeps = { db: Db; ownerPhone: string; publicUrl?: string; notifier: Notifier; tz: string }` (последующие задачи расширяют).
- Produces `createBot(opts: { token: string; botInfo?: UserFromGetMe; deps: BotDeps }): Bot`; `registerLinking(bot, deps)`, `registerFallback(bot, deps)`; `roleOf(db, telegramId): Role`, `summaryText(db, publicUrl?)`.
- Produces `AppDeps.notifier: Notifier` вместо `sendToOwner`.
- Produces тест-хелперы: `captureApi(api: Api | Bot, responders?)` возвращает `calls` и отвечает `{ message_id: N }` на `sendMessage`/`sendPhoto`; `makeBot(db, overrides?)` из `server/test/bot.ts` возвращает `{ bot, calls, notifier, deps }`; `buildTestApp()` возвращает `{ app, db, sent, notifications, loginAsOwner }`.

- [ ] **Step 1: Зависимость и конфиг**

```bash
npm i @anthropic-ai/sdk
```

`server/config.ts`, схема:
```ts
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
```

`server/config.test.ts`: в `base` добавить `ANTHROPIC_API_KEY: 'k'`, и тест:
```ts
  it('defaults AI_MODEL and TZ, requires ANTHROPIC_API_KEY', () => {
    const c = loadConfig(base)
    expect(c.AI_MODEL).toBe('claude-sonnet-5')
    expect(c.TZ).toBe('Europe/Moscow')
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: '' })).toThrow(/ANTHROPIC_API_KEY/)
  })
```

`.env.example`: строку `ANTHROPIC_API_KEY=` заменить на `ANTHROPIC_API_KEY=sk-ant-replace-me`, добавить `AI_MODEL=claude-sonnet-5`.

Run: `npx vitest run server/config.test.ts` → 4 passed.

- [ ] **Step 2: Тест-хелпер Telegram с ответами**

`server/test/telegram.ts`, заменить `captureApi` и добавить фабрики:
```ts
import { Bot, type Api } from 'grammy'

export type ApiCall = { method: string; payload: Record<string, unknown> }
type Responder = (payload: Record<string, unknown>) => unknown

let messageCounter = 100

export function captureApi(
  target: Api | Bot,
  responders: Record<string, Responder> = {},
  calls: ApiCall[] = [],
): ApiCall[] {
  const api = target instanceof Bot ? target.api : target
  api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>
    calls.push({ method, payload: p })
    const custom = responders[method]
    if (custom) return { ok: true, result: custom(p) }
    if (method === 'sendMessage' || method === 'sendPhoto') {
      return { ok: true, result: { message_id: ++messageCounter } }
    }
    if (method === 'sendMediaGroup') return { ok: true, result: [] }
    return { ok: true, result: true }
  })
  return calls
}

export function photoUpdate(fromId: number, fileId: string, uniqueId: string): Update {
  return {
    update_id: ++updateId,
    message: {
      ...base(fromId, 'User'),
      photo: [
        { file_id: `${fileId}-s`, file_unique_id: `${uniqueId}-s`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: uniqueId, width: 1280, height: 960 },
      ],
    },
  }
}

export function callbackUpdate(fromId: number, data: string, messageId = 1): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: { id: fromId, is_bot: false, first_name: 'User' },
      chat_instance: 'ci',
      data,
      message: { ...base(fromId, 'User'), message_id: messageId, text: 'x' },
    },
  }
}
```
Существующий `import type { Bot } from 'grammy'` заменить на импорт значения `Bot` (нужен `instanceof`).

- [ ] **Step 3: Тест Notifier**

`server/notify.test.ts` (полная замена):
```ts
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
```

Run: `npx vitest run server/notify.test.ts` → FAIL (нет `createTelegramNotifier`).

- [ ] **Step 4: server/notify.ts (полная замена)**

```ts
import { InputFile, InputMediaBuilder, type Api, type InlineKeyboard } from 'grammy'
import type { Db } from './db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from './db/settings.js'

export type SendExtra = { keyboard?: InlineKeyboard }

export type Notifier = {
  toOwner(text: string, extra?: SendExtra): Promise<number | null>
  toEmployee(telegramId: number, text: string, extra?: SendExtra): Promise<number | null>
  photosToOwner(paths: string[], caption: string, keyboard?: InlineKeyboard): Promise<boolean>
  editMessage(chatId: number, messageId: number, text: string): Promise<boolean>
}

export function createTelegramNotifier(api: Api, db: Db): Notifier {
  const ownerId = (): number | null => {
    const v = getSetting(db, OWNER_TELEGRAM_ID)
    return v ? Number(v) : null
  }

  async function send(chatId: number, text: string, extra?: SendExtra): Promise<number | null> {
    try {
      const msg = await api.sendMessage(chatId, text, {
        reply_markup: extra?.keyboard,
      })
      return msg.message_id
    } catch (err) {
      console.error('notify failed', chatId, err)
      return null
    }
  }

  return {
    toOwner(text, extra) {
      const id = ownerId()
      return id ? send(id, text, extra) : Promise.resolve(null)
    },
    toEmployee: send,
    async photosToOwner(paths, caption, keyboard) {
      const id = ownerId()
      if (!id || paths.length === 0) return false
      try {
        if (paths.length === 1) {
          await api.sendPhoto(id, new InputFile(paths[0]!), { caption, reply_markup: keyboard })
          return true
        }
        await api.sendMediaGroup(id, paths.map((p) => InputMediaBuilder.photo(new InputFile(p))))
        await api.sendMessage(id, caption, { reply_markup: keyboard })
        return true
      } catch (err) {
        console.error('photosToOwner failed', err)
        return false
      }
    },
    async editMessage(chatId, messageId, text) {
      try {
        await api.editMessageText(chatId, messageId, text)
        return true
      } catch {
        return false
      }
    },
  }
}
```

Run: `npx vitest run server/notify.test.ts` → 4 passed.

- [ ] **Step 5: Разбить бота**

`server/bot/deps.ts`:
```ts
import type { Db } from '../db/connect.js'
import type { Notifier } from '../notify.js'

export type BotDeps = {
  db: Db
  ownerPhone: string
  publicUrl?: string
  notifier: Notifier
  tz: string
}
```

`server/bot/roles.ts`:
```ts
import type { Db } from '../db/connect.js'
import { findEmployeeByTelegramId, listEmployees, type Employee } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'

export type Role =
  | { kind: 'owner' }
  | { kind: 'employee'; employee: Employee }
  | { kind: 'unknown' }

export function roleOf(db: Db, telegramId: number): Role {
  if (getSetting(db, OWNER_TELEGRAM_ID) === String(telegramId)) return { kind: 'owner' }
  const employee = findEmployeeByTelegramId(db, telegramId)
  if (employee && employee.status === 'active') return { kind: 'employee', employee }
  return { kind: 'unknown' }
}

export function summaryText(db: Db, publicUrl?: string): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const lines = [`Активны: ${active}`, `Приглашены: ${invited}`]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
```

`server/bot/linking.ts` (перенос из старого `createBot.ts`, без изменений поведения):
```ts
import type { Bot, Context } from 'grammy'
import { findEmployeeByPhone, findEmployeeByTelegramId, linkTelegram } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { normalizePhone } from '../lib/phone.js'
import type { BotDeps } from './deps.js'
import { BTN, contactRequest, employeeMenu, ownerMenu } from './keyboards.js'
import { roleOf, summaryText } from './roles.js'

export async function showHome(ctx: Context, deps: BotDeps): Promise<void> {
  if (!ctx.from) return
  const role = roleOf(deps.db, ctx.from.id)
  if (role.kind === 'owner') {
    await ctx.reply(`Вы владелец.\n${summaryText(deps.db, deps.publicUrl)}`, { reply_markup: ownerMenu() })
  } else if (role.kind === 'employee') {
    await ctx.reply(`Здравствуйте, ${role.employee.full_name}!`, { reply_markup: employeeMenu() })
  } else {
    await ctx.reply('Чтобы подключиться, поделитесь номером телефона.', { reply_markup: contactRequest() })
  }
}

export function registerLinking(bot: Bot, deps: BotDeps): void {
  const { db } = deps

  bot.command('start', (ctx) => showHome(ctx, deps))

  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact
    const fromId = ctx.from.id
    if (contact.user_id !== fromId) {
      await ctx.reply('Пришлите свой номер через кнопку «Поделиться номером».', { reply_markup: contactRequest() })
      return
    }
    const phone = normalizePhone(contact.phone_number)
    if (!phone) {
      await ctx.reply('Не удалось распознать номер. Обратитесь к владельцу.')
      return
    }
    if (phone === deps.ownerPhone) {
      const previous = getSetting(db, OWNER_TELEGRAM_ID)
      if (previous && previous !== String(fromId)) {
        console.warn(`owner telegram id changed from ${previous} to ${fromId}`)
      }
      setSetting(db, OWNER_TELEGRAM_ID, String(fromId))
      await ctx.reply(`Вы вошли как владелец.\n${summaryText(db, deps.publicUrl)}`, { reply_markup: ownerMenu() })
      return
    }
    const employee = findEmployeeByPhone(db, phone)
    if (!employee || employee.status === 'archived') {
      await ctx.reply('Вас ещё не добавили. Обратитесь к владельцу.')
      return
    }
    if (employee.status === 'active') {
      if (employee.telegram_id === fromId) return showHome(ctx, deps)
      await ctx.reply('Этот номер уже привязан к другому аккаунту Telegram.')
      return
    }
    const alreadyLinked = findEmployeeByTelegramId(db, fromId)
    if (alreadyLinked && alreadyLinked.id !== employee.id) {
      await ctx.reply('Ваш Telegram уже привязан к другому сотруднику. Обратитесь к владельцу.')
      return
    }
    const linked = linkTelegram(db, employee.id, fromId)!
    await ctx.reply(`Здравствуйте, ${linked.full_name}! Вы подключены.`, { reply_markup: employeeMenu() })
    await deps.notifier.toOwner(`Сотрудник ${linked.full_name} подключился к боту.`)
  })

  bot.hears([BTN.learning, BTN.quizzes, BTN.rating], async (ctx) => {
    if (!ctx.from) return
    if (roleOf(db, ctx.from.id).kind !== 'employee') return showHome(ctx, deps)
    await ctx.reply('Раздел появится в ближайшем обновлении.')
  })

  bot.hears(BTN.summary, async (ctx) => {
    if (!ctx.from) return
    if (roleOf(db, ctx.from.id).kind !== 'owner') return showHome(ctx, deps)
    await ctx.reply(summaryText(db, deps.publicUrl), { reply_markup: ownerMenu() })
  })
}

export function registerFallback(bot: Bot, deps: BotDeps): void {
  bot.on('message', (ctx) => showHome(ctx, deps))
}
```
Обратите внимание: `BTN.tasks` намеренно убран из заглушек, его обработчик появится в Task 6. До Task 6 нажатие «Мои задания» уходит в фолбэк `showHome`; в `createBot.test.ts` тест `answers menu buttons` переключить на `BTN.learning`.

`server/bot/createBot.ts` (полная замена):
```ts
import { Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { normalizePhone } from '../lib/phone.js'
import type { BotDeps } from './deps.js'
import { registerFallback, registerLinking } from './linking.js'

export type BotOptions = { token: string; botInfo?: UserFromGetMe; deps: BotDeps }

export function createBot(opts: BotOptions): Bot {
  const ownerPhone = normalizePhone(opts.deps.ownerPhone)
  if (!ownerPhone) throw new Error('OWNER_PHONE is not a valid phone number')
  const deps: BotDeps = { ...opts.deps, ownerPhone }

  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined)

  registerLinking(bot, deps)
  registerFallback(bot, deps)

  bot.catch(async (err) => {
    console.error('bot error', err.error)
    if (!err.ctx.chat) return
    try {
      await err.ctx.reply('Что-то пошло не так, попробуйте ещё раз.')
    } catch (replyErr) {
      console.error('bot error reply failed', replyErr)
    }
  })

  return bot
}
```
Порядок регистрации важен: модули из Task 6 и Task 8 будут вставляться между `registerLinking` и `registerFallback`.

- [ ] **Step 6: Хелпер makeBot и обновление тестов бота**

`server/test/bot.ts`:
```ts
import { Api } from 'grammy'
import type { Db } from '../db/connect.js'
import { createTelegramNotifier } from '../notify.js'
import { createBot } from '../bot/createBot.js'
import type { BotDeps } from '../bot/deps.js'
import { botInfo, captureApi, type ApiCall } from './telegram.js'

export const OWNER_PHONE = '+79990000000'

export function makeBot(db: Db, overrides: Partial<BotDeps> = {}) {
  const calls: ApiCall[] = []
  const api = new Api('test')
  captureApi(api, {}, calls)
  const notifier = createTelegramNotifier(api, db)
  const deps: BotDeps = {
    db,
    ownerPhone: OWNER_PHONE,
    publicUrl: 'https://admin.example',
    notifier,
    tz: 'Europe/Moscow',
    ...overrides,
  }
  const bot = createBot({ token: 'test', botInfo, deps })
  captureApi(bot, {}, calls)
  return { bot, calls, notifier, deps }
}
```

`server/bot/createBot.test.ts`: заменить `beforeEach` на
```ts
beforeEach(() => {
  db = openDb(':memory:')
  ;({ bot, calls } = makeBot(db))
  createPosition(db, 'Официант')
  createEmployee(db, { full_name: 'Иван Петров', phone: '+79990000001', position_id: 1 })
})
```
с `import { makeBot } from '../test/bot.js'`, убрать прямые импорты `createBot`/`captureApi`/`botInfo`, константу `OWNER_PHONE` брать из хелпера. В тесте меню заменить `BTN`-строку «Мои задания» на «Обучение» и ожидание клавиатуры оставить. Тест с ошибочным `sendMessage` (проверяет `bot.catch`) оставить как есть, он регистрирует свой трансформер поверх.

Run: `npx vitest run server/bot server/notify.test.ts` → все passed (13 + 4).

- [ ] **Step 7: App, auth, index, buildTestApp**

`server/app.ts`: в `AppDeps` заменить `sendToOwner` на `notifier: Notifier` (`import type { Notifier } from './notify.js'`), в `authRoutes` передавать `notifier`.

`server/api/auth.ts`: в `Opts` заменить `sendToOwner` на `notifier: Notifier`; вызов `await notifier.toOwner(\`Код входа в админку: ${code}\nДействует 5 минут.\`)`.

`server/test/buildTestApp.ts`:
```ts
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
  const app = buildApp({ config, db, auth, notifier })
  await app.ready()

  async function loginAsOwner(): Promise<string> {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    const code = notifications.at(-1)!.text.match(/\d{6}/)![0]
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    const c = res.cookies[0]!
    return `${c.name}=${c.value}`
  }

  return { app, db, sent, notifications, loginAsOwner }
}
```
`sent` остаётся массивом строк, как ожидают существующие тесты (`sent[0]`, `toHaveLength`). `server/api/auth.test.ts` менять не нужно. В `server/app.test.ts` в тесте статики заменить `sendToOwner: async () => true` на `notifier: fakeNotifier([])` и использовать `loadConfig(testEnv)` (оба импорта из `./test/buildTestApp.js`).

`server/index.ts`: заменить создание бота и приложения:
```ts
import { Api } from 'grammy'
import { createTelegramNotifier } from './notify.js'
// ...
const api = new Api(config.BOT_TOKEN)
const notifier = createTelegramNotifier(api, db)
const bot = createBot({
  token: config.BOT_TOKEN,
  deps: { db, ownerPhone: config.OWNER_PHONE, publicUrl: config.PUBLIC_URL, notifier, tz: config.TZ },
})
const app = buildApp({ config, db, auth, notifier, adminDistDir })
```
и удалить импорт `notifyOwner`.

- [ ] **Step 8: Всё зелёное, commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: все тесты passed (было 63, стало 64: +1 конфиг, notify 3→4, и ни один старый не удалён), tsc и сборка чистые.

```bash
git add -A
git commit -m "refactor: notifier interface, bot modules, stage 2 config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Время и расписание (чистые функции)

**Files:**
- Create: `server/lib/time.ts`, `server/lib/time.test.ts`, `server/tasks/schedule.ts`, `server/tasks/schedule.test.ts`

**Interfaces:**
- Produces (`server/lib/time.ts`):
  ```ts
  type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; weekday: number } // weekday 1=Пн … 7=Вс
  localParts(date: Date, tz: string): LocalParts
  zonedToUtc(p: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): Date
  addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number }
  formatLocal(date: Date, tz: string, now: Date): string   // 'HH:MM' в тот же локальный день, иначе 'DD.MM HH:MM'
  ```
- Produces (`server/tasks/schedule.ts`):
  ```ts
  scheduleSchema: zod-схема; type Schedule =
    | { kind: 'weekly'; days: number[]; times: string[] }
    | { kind: 'interval'; days: number[]; from: string; to: string; every_minutes: number }
  toMinutes(hhmm: string): number
  slotsForDay(schedule: Schedule, weekday: number): string[]   // отсортированные уникальные 'HH:MM', [] если день не входит
  nextRun(schedule: Schedule, after: Date, tz: string): Date    // строго позже after
  ```

- [ ] **Step 1: Тесты времени**

`server/lib/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { addDays, formatLocal, localParts, zonedToUtc } from './time.js'

const MSK = 'Europe/Moscow'

describe('time', () => {
  it('localParts converts to the zone and numbers weekdays Mon=1', () => {
    // 2026-09-07 is a Monday; 19:00Z = 22:00 MSK
    const p = localParts(new Date('2026-09-07T19:00:00Z'), MSK)
    expect(p).toEqual({ y: 2026, m: 9, d: 7, hh: 22, mm: 0, weekday: 1 })
    // 22:30Z Monday = 01:30 Tuesday MSK
    expect(localParts(new Date('2026-09-07T22:30:00Z'), MSK)).toMatchObject({ d: 8, hh: 1, mm: 30, weekday: 2 })
    expect(localParts(new Date('2026-09-13T12:00:00Z'), MSK).weekday).toBe(7)
  })

  it('zonedToUtc inverts localParts, including a DST zone', () => {
    expect(zonedToUtc({ y: 2026, m: 9, d: 7, hh: 22, mm: 0 }, MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    expect(zonedToUtc({ y: 2026, m: 9, d: 7, hh: 9, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-09-07T13:00:00.000Z')
    expect(zonedToUtc({ y: 2026, m: 1, d: 5, hh: 9, mm: 0 }, 'America/New_York').toISOString()).toBe('2026-01-05T14:00:00.000Z')
  })

  it('addDays crosses month boundaries', () => {
    expect(addDays({ y: 2026, m: 9, d: 30 }, 1)).toEqual({ y: 2026, m: 10, d: 1 })
    expect(addDays({ y: 2026, m: 1, d: 1 }, -1)).toEqual({ y: 2025, m: 12, d: 31 })
  })

  it('formatLocal shows time only on the same local day', () => {
    const now = new Date('2026-09-07T08:00:00Z')
    expect(formatLocal(new Date('2026-09-07T19:00:00Z'), MSK, now)).toBe('22:00')
    expect(formatLocal(new Date('2026-09-08T06:05:00Z'), MSK, now)).toBe('08.09 09:05')
  })
})
```

Run: `npx vitest run server/lib/time.test.ts` → FAIL (модуль не найден).

- [ ] **Step 2: server/lib/time.ts**

```ts
export type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {}
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday!] ?? 1,
  }
}

export function zonedToUtc(p: { y: number; m: number; d: number; hh: number; mm: number }, tz: string): Date {
  let guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm)
  for (let i = 0; i < 2; i++) {
    const lp = localParts(new Date(guess), tz)
    const asUtc = Date.UTC(lp.y, lp.m - 1, lp.d, lp.hh, lp.mm)
    guess -= asUtc - guess
  }
  return new Date(guess)
}

export function addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

const two = (n: number) => String(n).padStart(2, '0')

export function formatLocal(date: Date, tz: string, now: Date): string {
  const p = localParts(date, tz)
  const n = localParts(now, tz)
  const time = `${two(p.hh)}:${two(p.mm)}`
  if (p.y === n.y && p.m === n.m && p.d === n.d) return time
  return `${two(p.d)}.${two(p.m)} ${time}`
}
```

Run: `npx vitest run server/lib/time.test.ts` → 4 passed.

- [ ] **Step 3: Тесты расписания**

`server/tasks/schedule.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { nextRun, scheduleSchema, slotsForDay, type Schedule } from './schedule.js'

const MSK = 'Europe/Moscow'
const weekly: Schedule = { kind: 'weekly', days: [1, 3], times: ['22:00', '10:00'] }
const interval: Schedule = { kind: 'interval', days: [1, 2, 3, 4, 5, 6, 7], from: '10:00', to: '23:00', every_minutes: 120 }

describe('scheduleSchema', () => {
  it('accepts valid schedules and rejects bad ones', () => {
    expect(scheduleSchema.safeParse(weekly).success).toBe(true)
    expect(scheduleSchema.safeParse(interval).success).toBe(true)
    expect(scheduleSchema.safeParse({ kind: 'weekly', days: [], times: ['10:00'] }).success).toBe(false)
    expect(scheduleSchema.safeParse({ kind: 'weekly', days: [1], times: ['25:00'] }).success).toBe(false)
    expect(scheduleSchema.safeParse({ ...interval, from: '23:00', to: '10:00' }).success).toBe(false)
    expect(scheduleSchema.safeParse({ ...interval, every_minutes: 5 }).success).toBe(false)
  })
})

describe('slotsForDay', () => {
  it('sorts weekly times and skips other days', () => {
    expect(slotsForDay(weekly, 1)).toEqual(['10:00', '22:00'])
    expect(slotsForDay(weekly, 2)).toEqual([])
  })
  it('expands intervals inclusively up to "to"', () => {
    expect(slotsForDay(interval, 5)).toEqual(['10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'])
    expect(slotsForDay({ ...interval, to: '22:00' }, 5)).toHaveLength(7)
  })
})

describe('nextRun', () => {
  it('finds the next slot the same day, strictly after', () => {
    // Monday 10:30 MSK -> Monday 22:00 MSK
    expect(nextRun(weekly, new Date('2026-09-07T07:30:00Z'), MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    // exactly at 22:00 MSK -> Wednesday 10:00 MSK
    expect(nextRun(weekly, new Date('2026-09-07T19:00:00Z'), MSK).toISOString()).toBe('2026-09-09T07:00:00.000Z')
  })
  it('wraps to the next week', () => {
    // Wednesday 23:00 MSK -> next Monday 10:00 MSK
    expect(nextRun(weekly, new Date('2026-09-09T20:00:00Z'), MSK).toISOString()).toBe('2026-09-14T07:00:00.000Z')
  })
  it('handles intervals across the day boundary', () => {
    expect(nextRun(interval, new Date('2026-09-07T18:30:00Z'), MSK).toISOString()).toBe('2026-09-07T19:00:00.000Z')
    expect(nextRun(interval, new Date('2026-09-07T19:00:00Z'), MSK).toISOString()).toBe('2026-09-08T07:00:00.000Z')
  })
  it('respects the zone', () => {
    const s: Schedule = { kind: 'weekly', days: [1], times: ['09:00'] }
    expect(nextRun(s, new Date('2026-09-07T00:00:00Z'), 'America/New_York').toISOString()).toBe('2026-09-07T13:00:00.000Z')
  })
})
```

Run: `npx vitest run server/tasks/schedule.test.ts` → FAIL (модуль не найден).

- [ ] **Step 4: server/tasks/schedule.ts**

```ts
import { z } from 'zod'
import { addDays, localParts, zonedToUtc } from '../lib/time.js'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ')
const days = z.array(z.number().int().min(1).max(7)).min(1, 'Выберите хотя бы один день')

export const scheduleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('weekly'), days, times: z.array(time).min(1, 'Добавьте хотя бы одно время') }),
    z.object({
      kind: z.literal('interval'),
      days,
      from: time,
      to: time,
      every_minutes: z.number().int().min(15, 'Не чаще чем раз в 15 минут'),
    }),
  ])
  .refine((s) => s.kind === 'weekly' || toMinutes(s.from) < toMinutes(s.to), {
    message: 'Время «с» должно быть раньше времени «до»',
  })

export type Schedule = z.infer<typeof scheduleSchema>

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

export function slotsForDay(schedule: Schedule, weekday: number): string[] {
  if (!schedule.days.includes(weekday)) return []
  if (schedule.kind === 'weekly') return [...new Set(schedule.times)].sort()
  const out: string[] = []
  for (let t = toMinutes(schedule.from); t <= toMinutes(schedule.to); t += schedule.every_minutes) {
    out.push(fromMinutes(t))
  }
  return out
}

export function nextRun(schedule: Schedule, after: Date, tz: string): Date {
  const start = localParts(after, tz)
  for (let offset = 0; offset <= 7; offset++) {
    const day = addDays(start, offset)
    const weekday = ((start.weekday - 1 + offset) % 7) + 1
    for (const slot of slotsForDay(schedule, weekday)) {
      const [hh, mm] = slot.split(':').map(Number)
      const t = zonedToUtc({ ...day, hh: hh!, mm: mm! }, tz)
      if (t.getTime() > after.getTime()) return t
    }
  }
  throw new Error('schedule has no upcoming slot')
}
```

Run: `npx vitest run server/tasks/schedule.test.ts` → 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/lib/time.ts server/lib/time.test.ts server/tasks/schedule.ts server/tasks/schedule.test.ts
git commit -m "feat: zone-aware time helpers and task schedule functions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Миграция и репозитории заданий

**Files:**
- Modify: `server/db/migrations.ts` (добавить `002_tasks`)
- Create: `server/db/taskTemplates.ts`, `server/db/taskInstances.ts`, `server/db/taskSubmissions.ts`, `server/db/botStates.ts`, `server/test/fixtures.ts`
- Test: `server/db/tasks.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `scheduleSchema` из Task 2; `Db`.
- Produces (`taskTemplates.ts`):
  ```ts
  type TaskTemplate = { id: number; title: string; description: string; requires_photo: boolean; photo_criteria: string | null;
    auto_accept_threshold: number; assignee_mode: 'by_position' | 'by_employees'; distribution: 'each' | 'shared';
    schedule: Schedule | null; deadline_minutes: number; next_run_at: string | null; active: boolean; created_at: string;
    position_ids: number[]; employee_ids: number[] }
  type TaskTemplateInput = { title; description; requires_photo; photo_criteria; auto_accept_threshold; assignee_mode; distribution;
    schedule: Schedule | null; deadline_minutes; position_ids: number[]; employee_ids: number[] }
  createTaskTemplate(db, input, nextRunAt: string | null): TaskTemplate
  updateTaskTemplate(db, id, input, nextRunAt: string | null): TaskTemplate | null
  getTaskTemplate(db, id): TaskTemplate | null
  listTaskTemplates(db, opts?: { includeInactive?: boolean }): TaskTemplate[]
  setTemplateActive(db, id, active: boolean, nextRunAt: string | null): TaskTemplate | null
  setNextRunAt(db, id, iso: string | null): void
  listDueTemplates(db, nowIso): TaskTemplate[]      // active, schedule not null, next_run_at <= now
  eligibleEmployees(db, template): Employee[]        // активные, по должностям или поимённо
  ```
- Produces (`taskInstances.ts`):
  ```ts
  type InstanceStatus = 'open' | 'pending' | 'submitted' | 'review' | 'accepted' | 'overdue'
  type TaskInstance = { id; template_id; employee_id: number | null; slot_at; issued_at; due_at; claimed_at: string | null;
    status: InstanceStatus; completed_at: string | null; reminder_sent_at: string | null }
  type InstanceRow = TaskInstance & { title: string; requires_photo: boolean; employee_name: string | null; last_score: number | null }
  createInstance(db, input: { template_id; employee_id: number | null; slot_at; issued_at; due_at; status: 'open' | 'pending' }): TaskInstance | null  // null при дубликате
  getInstance(db, id): TaskInstance | null
  getInstanceRow(db, id): InstanceRow | null
  listEmployeeInstances(db, employeeId, statuses: InstanceStatus[]): InstanceRow[]
  listInstances(db, f: { status?; employee_id?; template_id?; from?; to? }): InstanceRow[]
  setInstanceStatus(db, id, status, extra?: { completed_at?: string | null }): void
  claimInstance(db, id, employeeId, nowIso): boolean          // атомарно, только из open
  addOffer(db, instanceId, telegramId, messageId): void
  listOffers(db, instanceId): { telegram_id: number; message_id: number }[]
  listReminderCandidates(db, nowIso): TaskInstance[]         // pending, reminder_sent_at null
  markReminderSent(db, id, nowIso): void
  listOverdueCandidates(db, nowIso): TaskInstance[]          // open|pending с due_at < now
  ```
- Produces (`taskSubmissions.ts`):
  ```ts
  type Decision = 'auto_accepted' | 'needs_review' | 'owner_accepted' | 'owner_rejected'
  type Submission = { id; instance_id; created_at; ai_status: 'pending' | 'done' | 'failed'; ai_attempts: number;
    ai_score: number | null; ai_verdict: string | null; ai_issues: string[]; decision: Decision | null; owner_comment: string | null; decided_at: string | null }
  type Photo = { id; submission_id; position: number; path: string; telegram_file_unique_id: string; deleted_at: string | null }
  type ReviewRow = Submission & { instance_id; template_id; title; photo_criteria: string | null; employee_id: number; employee_name: string; photos: Photo[] }
  createSubmission(db, instanceId, nowIso, photos: { path: string; fileUniqueId: string }[]): Submission
  getSubmission(db, id): Submission | null
  listPhotos(db, submissionId): Photo[]
  photoExists(db, fileUniqueId): boolean
  listSubmissionsForInstance(db, instanceId): (Submission & { photos: Photo[] })[]
  markAiStarted(db, id): void                                  // ai_attempts + 1
  saveAiResult(db, id, r: { score; verdict; issues }, decision: 'auto_accepted' | 'needs_review', nowIso): void
  markAiFailed(db, id, nowIso): void                            // ai_status failed, decision needs_review
  setOwnerDecision(db, id, decision: 'owner_accepted' | 'owner_rejected', comment: string | null, nowIso): boolean  // только из needs_review
  listReviewQueue(db): ReviewRow[]                              // decision = needs_review, старые первыми
  getReviewRow(db, submissionId): ReviewRow | null
  listStaleAiPending(db, beforeIso): Submission[]
  listPhotosOlderThan(db, beforeIso): Photo[]                   // deleted_at null
  markPhotoDeleted(db, id, nowIso): void
  ```
- Produces (`botStates.ts`): `getState<T>(db, telegramId): T | null`, `setState(db, telegramId, state: unknown)`, `clearState(db, telegramId)`.
- Produces (`server/test/fixtures.ts`): `seedRestaurant(db)` создаёт должности Повар(1), Администратор(2), Бариста(3) и сотрудников: Иван Петров (бариста, tg 500, active), Анна Смирнова (бариста, tg 501, active), Пётр Кузнецов (повар, tg 502, active), Ольга Новикова (администратор, invited, без tg); возвращает `{ positions, employees }` с id.

- [ ] **Step 1: Миграция**

Добавить в массив `migrations`:
```ts
  {
    name: '002_tasks',
    sql: `
      create table task_templates (
        id integer primary key autoincrement,
        title text not null,
        description text not null default '',
        requires_photo integer not null default 0,
        photo_criteria text,
        auto_accept_threshold integer not null default 80,
        assignee_mode text not null check (assignee_mode in ('by_position', 'by_employees')),
        distribution text not null check (distribution in ('each', 'shared')),
        schedule_kind text not null check (schedule_kind in ('once', 'weekly', 'interval')),
        schedule text,
        deadline_minutes integer not null,
        next_run_at text,
        active integer not null default 1,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create table task_template_positions (
        template_id integer not null references task_templates(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (template_id, position_id)
      );

      create table task_template_employees (
        template_id integer not null references task_templates(id) on delete cascade,
        employee_id integer not null references employees(id),
        primary key (template_id, employee_id)
      );

      create table task_instances (
        id integer primary key autoincrement,
        template_id integer not null references task_templates(id),
        employee_id integer references employees(id),
        slot_at text not null,
        issued_at text not null,
        due_at text not null,
        claimed_at text,
        status text not null
          check (status in ('open', 'pending', 'submitted', 'review', 'accepted', 'overdue')),
        completed_at text,
        reminder_sent_at text
      );
      create unique index task_instances_each
        on task_instances(template_id, slot_at, employee_id) where employee_id is not null;
      create unique index task_instances_shared
        on task_instances(template_id, slot_at) where employee_id is null;
      create index task_instances_status on task_instances(status, due_at);

      create table task_offers (
        id integer primary key autoincrement,
        instance_id integer not null references task_instances(id) on delete cascade,
        telegram_id integer not null,
        message_id integer not null
      );

      create table task_submissions (
        id integer primary key autoincrement,
        instance_id integer not null references task_instances(id),
        created_at text not null,
        ai_status text not null default 'pending' check (ai_status in ('pending', 'done', 'failed')),
        ai_attempts integer not null default 0,
        ai_score integer,
        ai_verdict text,
        ai_issues text not null default '[]',
        decision text check (decision in ('auto_accepted', 'needs_review', 'owner_accepted', 'owner_rejected')),
        owner_comment text,
        decided_at text
      );

      create table task_photos (
        id integer primary key autoincrement,
        submission_id integer not null references task_submissions(id) on delete cascade,
        position integer not null,
        path text not null,
        telegram_file_unique_id text not null unique,
        deleted_at text
      );
    `,
  },
```

- [ ] **Step 2: Фикстуры**

`server/test/fixtures.ts`:
```ts
import type { Db } from '../db/connect.js'
import { createEmployee, linkTelegram, type Employee } from '../db/employees.js'
import { createPosition, type Position } from '../db/positions.js'

export function seedRestaurant(db: Db) {
  const cook = createPosition(db, 'Повар')
  const admin = createPosition(db, 'Администратор')
  const barista = createPosition(db, 'Бариста')
  const ivan = createEmployee(db, { full_name: 'Иван Петров', phone: '+79990000001', position_id: barista.id })
  const anna = createEmployee(db, { full_name: 'Анна Смирнова', phone: '+79990000002', position_id: barista.id })
  const petr = createEmployee(db, { full_name: 'Пётр Кузнецов', phone: '+79990000003', position_id: cook.id })
  const olga = createEmployee(db, { full_name: 'Ольга Новикова', phone: '+79990000004', position_id: admin.id })
  linkTelegram(db, ivan.id, 500)
  linkTelegram(db, anna.id, 501)
  linkTelegram(db, petr.id, 502)
  const positions: Record<'cook' | 'admin' | 'barista', Position> = { cook, admin, barista }
  const employees: Record<'ivan' | 'anna' | 'petr' | 'olga', Employee> = {
    ivan: { ...ivan, telegram_id: 500, status: 'active' },
    anna: { ...anna, telegram_id: 501, status: 'active' },
    petr: { ...petr, telegram_id: 502, status: 'active' },
    olga,
  }
  return { positions, employees }
}
```

- [ ] **Step 3: Тесты репозиториев**

`server/db/tasks.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { seedRestaurant } from '../test/fixtures.js'
import {
  createTaskTemplate, eligibleEmployees, getTaskTemplate, listDueTemplates, listTaskTemplates,
  setTemplateActive, updateTaskTemplate, type TaskTemplateInput,
} from './taskTemplates.js'
import {
  addOffer, claimInstance, createInstance, getInstanceRow, listEmployeeInstances, listInstances,
  listOffers, listOverdueCandidates, listReminderCandidates, markReminderSent, setInstanceStatus,
} from './taskInstances.js'
import {
  createSubmission, getSubmission, listReviewQueue, listStaleAiPending, markAiFailed, markAiStarted,
  photoExists, saveAiResult, setOwnerDecision, listPhotosOlderThan, markPhotoDeleted,
} from './taskSubmissions.js'
import { clearState, getState, setState } from './botStates.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
const NOW = '2026-09-07T10:00:00.000Z'

const baseInput: TaskTemplateInput = {
  title: 'Помыть кофемашину',
  description: 'Группы, холдеры, поддон',
  requires_photo: true,
  photo_criteria: 'Группы без кофейных остатков, поддон пустой',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60,
  position_ids: [],
  employee_ids: [],
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('task templates', () => {
  it('creates with links and reads back typed fields', () => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, '2026-09-07T19:00:00.000Z')
    expect(t).toMatchObject({ id: 1, requires_photo: true, active: true, next_run_at: '2026-09-07T19:00:00.000Z' })
    expect(t.schedule).toEqual(baseInput.schedule)
    expect(t.position_ids).toEqual([seed.positions.barista.id])
    expect(getTaskTemplate(db, 1)).toEqual(t)
  })

  it('updates links and schedule, lists active only by default', () => {
    createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    const u = updateTaskTemplate(db, 1, { ...baseInput, assignee_mode: 'by_employees', employee_ids: [seed.employees.petr.id], schedule: null }, null)!
    expect(u.employee_ids).toEqual([seed.employees.petr.id])
    expect(u.position_ids).toEqual([])
    expect(u.schedule).toBeNull()
    setTemplateActive(db, 1, false, null)
    expect(listTaskTemplates(db)).toEqual([])
    expect(listTaskTemplates(db, { includeInactive: true })).toHaveLength(1)
  })

  it('resolves eligible employees: active by position or explicit', () => {
    const byPos = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id, seed.positions.admin.id] }, null)
    expect(eligibleEmployees(db, byPos).map((e) => e.full_name).sort()).toEqual(['Анна Смирнова', 'Иван Петров'])
    const explicit = createTaskTemplate(db, { ...baseInput, assignee_mode: 'by_employees', employee_ids: [seed.employees.petr.id, seed.employees.olga.id] }, null)
    expect(eligibleEmployees(db, explicit).map((e) => e.full_name)).toEqual(['Пётр Кузнецов'])
  })

  it('lists due templates', () => {
    createTaskTemplate(db, baseInput, '2026-09-07T09:59:00.000Z')
    createTaskTemplate(db, baseInput, '2026-09-07T10:01:00.000Z')
    createTaskTemplate(db, { ...baseInput, schedule: null }, null)
    expect(listDueTemplates(db, NOW).map((t) => t.id)).toEqual([1])
  })
})

describe('task instances', () => {
  let templateId: number
  beforeEach(() => {
    templateId = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null).id
  })

  it('creates, dedupes per employee and per shared slot', () => {
    const a = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })
    expect(a?.status).toBe('pending')
    expect(createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })).toBeNull()
    expect(createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })).not.toBeNull()
    expect(createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })).toBeNull()
  })

  it('claims a shared instance once', () => {
    const shared = createInstance(db, { template_id: templateId, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'open' })!
    addOffer(db, shared.id, 500, 10)
    addOffer(db, shared.id, 501, 11)
    expect(claimInstance(db, shared.id, seed.employees.ivan.id, NOW)).toBe(true)
    expect(claimInstance(db, shared.id, seed.employees.anna.id, NOW)).toBe(false)
    expect(getInstanceRow(db, shared.id)).toMatchObject({ status: 'pending', employee_id: seed.employees.ivan.id, employee_name: 'Иван Петров', claimed_at: NOW })
    expect(listOffers(db, shared.id)).toEqual([{ telegram_id: 500, message_id: 10 }, { telegram_id: 501, message_id: 11 }])
  })

  it('lists for employee and with filters; row carries title and last score', () => {
    const i = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    createInstance(db, { template_id: templateId, employee_id: seed.employees.anna.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'accepted' })
    expect(listEmployeeInstances(db, seed.employees.ivan.id, ['pending', 'submitted', 'review'])).toHaveLength(1)
    expect(listInstances(db, { status: 'accepted' })).toHaveLength(1)
    expect(listInstances(db, { employee_id: seed.employees.ivan.id })[0]).toMatchObject({ title: 'Помыть кофемашину', requires_photo: true, last_score: null })
    const s = createSubmission(db, i.id, NOW, [{ path: 'p/1.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, s.id, { score: 91, verdict: 'ok', issues: [] }, 'auto_accepted', NOW)
    expect(listInstances(db, { employee_id: seed.employees.ivan.id })[0]!.last_score).toBe(91)
    expect(listInstances(db, { from: '2026-09-08T00:00:00.000Z' })).toEqual([])
  })

  it('reminder and overdue candidates', () => {
    const p = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    const late = createInstance(db, { template_id: templateId, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T08:00:00.000Z', issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'pending' })!
    const o = createInstance(db, { template_id: templateId, employee_id: null, slot_at: '2026-09-07T08:00:00.000Z', issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'open' })!
    createInstance(db, { template_id: templateId, employee_id: seed.employees.petr.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T09:00:00.000Z', status: 'review' })
    // напоминание только для pending с дедлайном в будущем
    expect(listReminderCandidates(db, NOW).map((x) => x.id)).toEqual([p.id])
    markReminderSent(db, p.id, NOW)
    expect(listReminderCandidates(db, NOW)).toEqual([])
    // просрочка: pending и open с истёкшим дедлайном, review не трогаем
    expect(listOverdueCandidates(db, NOW).map((x) => x.id).sort()).toEqual([late.id, o.id].sort())
    setInstanceStatus(db, p.id, 'accepted', { completed_at: NOW })
    expect(getInstanceRow(db, p.id)).toMatchObject({ status: 'accepted', completed_at: NOW })
  })
})

describe('submissions', () => {
  let instanceId: number
  beforeEach(() => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    instanceId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'submitted' })!.id
  })

  it('creates with photos, tracks ai lifecycle and owner decision', () => {
    const s = createSubmission(db, instanceId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }, { path: 'b.jpg', fileUniqueId: 'u2' }])
    expect(s).toMatchObject({ ai_status: 'pending', ai_attempts: 0, decision: null, ai_issues: [] })
    expect(photoExists(db, 'u1')).toBe(true)
    expect(photoExists(db, 'zz')).toBe(false)
    markAiStarted(db, s.id)
    saveAiResult(db, s.id, { score: 55, verdict: 'Грязный поддон', issues: ['поддон'] }, 'needs_review', NOW)
    expect(getSubmission(db, s.id)).toMatchObject({ ai_status: 'done', ai_attempts: 1, ai_score: 55, ai_issues: ['поддон'], decision: 'needs_review' })
    const queue = listReviewQueue(db)
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ title: 'Помыть кофемашину', employee_name: 'Иван Петров' })
    expect(queue[0]!.photos).toHaveLength(2)
    expect(setOwnerDecision(db, s.id, 'owner_rejected', 'Переделать', NOW)).toBe(true)
    expect(setOwnerDecision(db, s.id, 'owner_accepted', null, NOW)).toBe(false)
    expect(listReviewQueue(db)).toEqual([])
  })

  it('failed ai goes to review; stale pending is listed', () => {
    const s = createSubmission(db, instanceId, '2026-09-07T09:50:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    expect(listStaleAiPending(db, '2026-09-07T09:57:00.000Z').map((x) => x.id)).toEqual([s.id])
    markAiFailed(db, s.id, NOW)
    expect(getSubmission(db, s.id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review' })
    expect(listStaleAiPending(db, NOW)).toEqual([])
  })

  it('photo retention helpers', () => {
    const s = createSubmission(db, instanceId, '2026-06-01T00:00:00.000Z', [{ path: 'old.jpg', fileUniqueId: 'u1' }])
    const old = listPhotosOlderThan(db, '2026-07-01T00:00:00.000Z')
    expect(old.map((p) => p.path)).toEqual(['old.jpg'])
    markPhotoDeleted(db, old[0]!.id, NOW)
    expect(listPhotosOlderThan(db, '2026-07-01T00:00:00.000Z')).toEqual([])
    expect(getSubmission(db, s.id)).not.toBeNull()
  })
})

describe('bot states', () => {
  it('round-trips json and clears', () => {
    expect(getState(db, 500)).toBeNull()
    setState(db, 500, { kind: 'collecting_photos', instance_id: 1, photos: [] })
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('collecting_photos')
    setState(db, 500, { kind: 'x' })
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('x')
    clearState(db, 500)
    expect(getState(db, 500)).toBeNull()
  })
})
```

Run: `npx vitest run server/db/tasks.test.ts` → FAIL (модули не найдены).

- [ ] **Step 4: server/db/botStates.ts**

```ts
import type { Db } from './connect.js'

export function getState<T = unknown>(db: Db, telegramId: number): T | null {
  const row = db.prepare('select state from bot_states where telegram_id = ?').get(telegramId) as { state: string } | undefined
  return row ? (JSON.parse(row.state) as T) : null
}

export function setState(db: Db, telegramId: number, state: unknown): void {
  db.prepare(
    'insert into bot_states (telegram_id, state) values (?, ?) on conflict(telegram_id) do update set state = excluded.state',
  ).run(telegramId, JSON.stringify(state))
}

export function clearState(db: Db, telegramId: number): void {
  db.prepare('delete from bot_states where telegram_id = ?').run(telegramId)
}
```

- [ ] **Step 5: server/db/taskTemplates.ts**

```ts
import type { Db } from './connect.js'
import type { Employee } from './employees.js'
import type { Schedule } from '../tasks/schedule.js'

export type AssigneeMode = 'by_position' | 'by_employees'
export type Distribution = 'each' | 'shared'

export type TaskTemplate = {
  id: number
  title: string
  description: string
  requires_photo: boolean
  photo_criteria: string | null
  auto_accept_threshold: number
  assignee_mode: AssigneeMode
  distribution: Distribution
  schedule: Schedule | null
  deadline_minutes: number
  next_run_at: string | null
  active: boolean
  created_at: string
  position_ids: number[]
  employee_ids: number[]
}

export type TaskTemplateInput = Omit<TaskTemplate, 'id' | 'next_run_at' | 'active' | 'created_at'>

type Row = {
  id: number; title: string; description: string; requires_photo: number; photo_criteria: string | null
  auto_accept_threshold: number; assignee_mode: AssigneeMode; distribution: Distribution
  schedule_kind: 'once' | 'weekly' | 'interval'; schedule: string | null; deadline_minutes: number
  next_run_at: string | null; active: number; created_at: string
}

const columns =
  'id, title, description, requires_photo, photo_criteria, auto_accept_threshold, assignee_mode, distribution, schedule_kind, schedule, deadline_minutes, next_run_at, active, created_at'

function hydrate(db: Db, row: Row): TaskTemplate {
  const position_ids = (db.prepare('select position_id from task_template_positions where template_id = ? order by position_id').all(row.id) as { position_id: number }[]).map((r) => r.position_id)
  const employee_ids = (db.prepare('select employee_id from task_template_employees where template_id = ? order by employee_id').all(row.id) as { employee_id: number }[]).map((r) => r.employee_id)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    requires_photo: row.requires_photo === 1,
    photo_criteria: row.photo_criteria,
    auto_accept_threshold: row.auto_accept_threshold,
    assignee_mode: row.assignee_mode,
    distribution: row.distribution,
    schedule: row.schedule ? (JSON.parse(row.schedule) as Schedule) : null,
    deadline_minutes: row.deadline_minutes,
    next_run_at: row.next_run_at,
    active: row.active === 1,
    created_at: row.created_at,
    position_ids,
    employee_ids,
  }
}

function writeLinks(db: Db, id: number, input: TaskTemplateInput): void {
  db.prepare('delete from task_template_positions where template_id = ?').run(id)
  db.prepare('delete from task_template_employees where template_id = ?').run(id)
  const ip = db.prepare('insert into task_template_positions (template_id, position_id) values (?, ?)')
  const ie = db.prepare('insert into task_template_employees (template_id, employee_id) values (?, ?)')
  if (input.assignee_mode === 'by_position') for (const p of input.position_ids) ip.run(id, p)
  else for (const e of input.employee_ids) ie.run(id, e)
}

export function getTaskTemplate(db: Db, id: number): TaskTemplate | null {
  const row = db.prepare(`select ${columns} from task_templates where id = ?`).get(id) as Row | undefined
  return row ? hydrate(db, row) : null
}

export function createTaskTemplate(db: Db, input: TaskTemplateInput, nextRunAt: string | null): TaskTemplate {
  return db.transaction(() => {
    const info = db
      .prepare(
        `insert into task_templates (title, description, requires_photo, photo_criteria, auto_accept_threshold, assignee_mode, distribution, schedule_kind, schedule, deadline_minutes, next_run_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title, input.description, input.requires_photo ? 1 : 0, input.requires_photo ? input.photo_criteria : null,
        input.auto_accept_threshold, input.assignee_mode, input.distribution, input.schedule?.kind ?? 'once',
        input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt,
      )
    const id = Number(info.lastInsertRowid)
    writeLinks(db, id, input)
    return getTaskTemplate(db, id)!
  })()
}

export function updateTaskTemplate(db: Db, id: number, input: TaskTemplateInput, nextRunAt: string | null): TaskTemplate | null {
  return db.transaction(() => {
    const info = db
      .prepare(
        `update task_templates set title = ?, description = ?, requires_photo = ?, photo_criteria = ?, auto_accept_threshold = ?, assignee_mode = ?, distribution = ?, schedule_kind = ?, schedule = ?, deadline_minutes = ?, next_run_at = ? where id = ?`,
      )
      .run(
        input.title, input.description, input.requires_photo ? 1 : 0, input.requires_photo ? input.photo_criteria : null,
        input.auto_accept_threshold, input.assignee_mode, input.distribution, input.schedule?.kind ?? 'once',
        input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt, id,
      )
    if (info.changes === 0) return null
    writeLinks(db, id, input)
    return getTaskTemplate(db, id)
  })()
}

export function listTaskTemplates(db: Db, opts: { includeInactive?: boolean } = {}): TaskTemplate[] {
  const where = opts.includeInactive ? '' : 'where active = 1'
  const rows = db.prepare(`select ${columns} from task_templates ${where} order by active desc, title`).all() as Row[]
  return rows.map((r) => hydrate(db, r))
}

export function setTemplateActive(db: Db, id: number, active: boolean, nextRunAt: string | null): TaskTemplate | null {
  const info = db.prepare('update task_templates set active = ?, next_run_at = ? where id = ?').run(active ? 1 : 0, nextRunAt, id)
  return info.changes === 0 ? null : getTaskTemplate(db, id)
}

export function setNextRunAt(db: Db, id: number, iso: string | null): void {
  db.prepare('update task_templates set next_run_at = ? where id = ?').run(iso, id)
}

export function listDueTemplates(db: Db, nowIso: string): TaskTemplate[] {
  const rows = db
    .prepare(`select ${columns} from task_templates where active = 1 and schedule is not null and next_run_at is not null and next_run_at <= ? order by next_run_at`)
    .all(nowIso) as Row[]
  return rows.map((r) => hydrate(db, r))
}

const employeeColumns = 'e.id, e.full_name, e.phone, e.position_id, e.telegram_id, e.status, e.created_at'

export function eligibleEmployees(db: Db, template: TaskTemplate): Employee[] {
  if (template.assignee_mode === 'by_position') {
    return db
      .prepare(
        `select ${employeeColumns} from employees e join task_template_positions tp on tp.position_id = e.position_id
         where tp.template_id = ? and e.status = 'active' order by e.full_name`,
      )
      .all(template.id) as Employee[]
  }
  return db
    .prepare(
      `select ${employeeColumns} from employees e join task_template_employees te on te.employee_id = e.id
       where te.template_id = ? and e.status = 'active' order by e.full_name`,
    )
    .all(template.id) as Employee[]
}
```

- [ ] **Step 6: server/db/taskInstances.ts**

```ts
import type { Db } from './connect.js'

export type InstanceStatus = 'open' | 'pending' | 'submitted' | 'review' | 'accepted' | 'overdue'

export type TaskInstance = {
  id: number
  template_id: number
  employee_id: number | null
  slot_at: string
  issued_at: string
  due_at: string
  claimed_at: string | null
  status: InstanceStatus
  completed_at: string | null
  reminder_sent_at: string | null
}

export type InstanceRow = TaskInstance & {
  title: string
  requires_photo: boolean
  employee_name: string | null
  last_score: number | null
}

const cols = 'i.id, i.template_id, i.employee_id, i.slot_at, i.issued_at, i.due_at, i.claimed_at, i.status, i.completed_at, i.reminder_sent_at'
const rowSelect = `select ${cols}, t.title, t.requires_photo, e.full_name as employee_name,
  (select s.ai_score from task_submissions s where s.instance_id = i.id order by s.id desc limit 1) as last_score
  from task_instances i join task_templates t on t.id = i.template_id left join employees e on e.id = i.employee_id`

type RawRow = Omit<InstanceRow, 'requires_photo'> & { requires_photo: number }
const toRow = (r: RawRow): InstanceRow => ({ ...r, requires_photo: r.requires_photo === 1 })

export function createInstance(
  db: Db,
  input: { template_id: number; employee_id: number | null; slot_at: string; issued_at: string; due_at: string; status: 'open' | 'pending' },
): TaskInstance | null {
  try {
    const info = db
      .prepare('insert into task_instances (template_id, employee_id, slot_at, issued_at, due_at, status) values (?, ?, ?, ?, ?, ?)')
      .run(input.template_id, input.employee_id, input.slot_at, input.issued_at, input.due_at, input.status)
    return getInstance(db, Number(info.lastInsertRowid))
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

export function getInstance(db: Db, id: number): TaskInstance | null {
  return (db.prepare(`select ${cols} from task_instances i where i.id = ?`).get(id) as TaskInstance) ?? null
}

export function getInstanceRow(db: Db, id: number): InstanceRow | null {
  const r = db.prepare(`${rowSelect} where i.id = ?`).get(id) as RawRow | undefined
  return r ? toRow(r) : null
}

export function listEmployeeInstances(db: Db, employeeId: number, statuses: InstanceStatus[]): InstanceRow[] {
  const marks = statuses.map(() => '?').join(', ')
  const rows = db.prepare(`${rowSelect} where i.employee_id = ? and i.status in (${marks}) order by i.due_at`).all(employeeId, ...statuses) as RawRow[]
  return rows.map(toRow)
}

export function listInstances(
  db: Db,
  f: { status?: InstanceStatus; employee_id?: number; template_id?: number; from?: string; to?: string },
): InstanceRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.status) { where.push('i.status = ?'); args.push(f.status) }
  if (f.employee_id) { where.push('i.employee_id = ?'); args.push(f.employee_id) }
  if (f.template_id) { where.push('i.template_id = ?'); args.push(f.template_id) }
  if (f.from) { where.push('i.issued_at >= ?'); args.push(f.from) }
  if (f.to) { where.push('i.issued_at < ?'); args.push(f.to) }
  const sql = `${rowSelect} ${where.length ? 'where ' + where.join(' and ') : ''} order by i.issued_at desc, i.id desc limit 500`
  return (db.prepare(sql).all(...args) as RawRow[]).map(toRow)
}

export function setInstanceStatus(db: Db, id: number, status: InstanceStatus, extra: { completed_at?: string | null } = {}): void {
  if ('completed_at' in extra) {
    db.prepare('update task_instances set status = ?, completed_at = ? where id = ?').run(status, extra.completed_at ?? null, id)
  } else {
    db.prepare('update task_instances set status = ? where id = ?').run(status, id)
  }
}

export function claimInstance(db: Db, id: number, employeeId: number, nowIso: string): boolean {
  const info = db
    .prepare("update task_instances set employee_id = ?, claimed_at = ?, status = 'pending' where id = ? and status = 'open'")
    .run(employeeId, nowIso, id)
  return info.changes === 1
}

export function addOffer(db: Db, instanceId: number, telegramId: number, messageId: number): void {
  db.prepare('insert into task_offers (instance_id, telegram_id, message_id) values (?, ?, ?)').run(instanceId, telegramId, messageId)
}

export function listOffers(db: Db, instanceId: number): { telegram_id: number; message_id: number }[] {
  return db.prepare('select telegram_id, message_id from task_offers where instance_id = ? order by id').all(instanceId) as { telegram_id: number; message_id: number }[]
}

export function listReminderCandidates(db: Db, nowIso: string): TaskInstance[] {
  return db
    .prepare(`select ${cols} from task_instances i where i.status = 'pending' and i.reminder_sent_at is null and i.due_at > ? order by i.due_at`)
    .all(nowIso) as TaskInstance[]
}

export function markReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update task_instances set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listOverdueCandidates(db: Db, nowIso: string): TaskInstance[] {
  return db
    .prepare(`select ${cols} from task_instances i where i.status in ('open', 'pending') and i.due_at < ? order by i.due_at`)
    .all(nowIso) as TaskInstance[]
}
```

- [ ] **Step 7: server/db/taskSubmissions.ts**

```ts
import type { Db } from './connect.js'

export type Decision = 'auto_accepted' | 'needs_review' | 'owner_accepted' | 'owner_rejected'
export type AiStatus = 'pending' | 'done' | 'failed'

export type Submission = {
  id: number
  instance_id: number
  created_at: string
  ai_status: AiStatus
  ai_attempts: number
  ai_score: number | null
  ai_verdict: string | null
  ai_issues: string[]
  decision: Decision | null
  owner_comment: string | null
  decided_at: string | null
}

export type Photo = {
  id: number
  submission_id: number
  position: number
  path: string
  telegram_file_unique_id: string
  deleted_at: string | null
}

export type ReviewRow = Submission & {
  template_id: number
  title: string
  photo_criteria: string | null
  employee_id: number
  employee_name: string
  photos: Photo[]
}

type Raw = Omit<Submission, 'ai_issues'> & { ai_issues: string }
const cols = 's.id, s.instance_id, s.created_at, s.ai_status, s.ai_attempts, s.ai_score, s.ai_verdict, s.ai_issues, s.decision, s.owner_comment, s.decided_at'
const hydrate = (r: Raw): Submission => ({ ...r, ai_issues: JSON.parse(r.ai_issues) as string[] })

export function createSubmission(db: Db, instanceId: number, nowIso: string, photos: { path: string; fileUniqueId: string }[]): Submission {
  return db.transaction(() => {
    const info = db.prepare('insert into task_submissions (instance_id, created_at) values (?, ?)').run(instanceId, nowIso)
    const id = Number(info.lastInsertRowid)
    const ins = db.prepare('insert into task_photos (submission_id, position, path, telegram_file_unique_id) values (?, ?, ?, ?)')
    photos.forEach((p, i) => ins.run(id, i + 1, p.path, p.fileUniqueId))
    return getSubmission(db, id)!
  })()
}

export function getSubmission(db: Db, id: number): Submission | null {
  const r = db.prepare(`select ${cols} from task_submissions s where s.id = ?`).get(id) as Raw | undefined
  return r ? hydrate(r) : null
}

export function listPhotos(db: Db, submissionId: number): Photo[] {
  return db.prepare('select * from task_photos where submission_id = ? order by position').all(submissionId) as Photo[]
}

export function photoExists(db: Db, fileUniqueId: string): boolean {
  return db.prepare('select 1 from task_photos where telegram_file_unique_id = ?').get(fileUniqueId) !== undefined
}

export function listSubmissionsForInstance(db: Db, instanceId: number): (Submission & { photos: Photo[] })[] {
  const rows = db.prepare(`select ${cols} from task_submissions s where s.instance_id = ? order by s.id`).all(instanceId) as Raw[]
  return rows.map((r) => ({ ...hydrate(r), photos: listPhotos(db, r.id) }))
}

export function markAiStarted(db: Db, id: number): void {
  db.prepare('update task_submissions set ai_attempts = ai_attempts + 1 where id = ?').run(id)
}

export function saveAiResult(
  db: Db, id: number, r: { score: number; verdict: string; issues: string[] },
  decision: 'auto_accepted' | 'needs_review', nowIso: string,
): void {
  db.prepare(
    `update task_submissions set ai_status = 'done', ai_score = ?, ai_verdict = ?, ai_issues = ?, decision = ?, decided_at = case when ? = 'auto_accepted' then ? else null end where id = ?`,
  ).run(r.score, r.verdict, JSON.stringify(r.issues), decision, decision, nowIso, id)
}

export function markAiFailed(db: Db, id: number, _nowIso: string): void {
  db.prepare("update task_submissions set ai_status = 'failed', decision = 'needs_review' where id = ?").run(id)
}

export function setOwnerDecision(db: Db, id: number, decision: 'owner_accepted' | 'owner_rejected', comment: string | null, nowIso: string): boolean {
  const info = db
    .prepare("update task_submissions set decision = ?, owner_comment = ?, decided_at = ? where id = ? and decision = 'needs_review'")
    .run(decision, comment, nowIso, id)
  return info.changes === 1
}

const reviewSelect = `select ${cols}, i.template_id, t.title, t.photo_criteria, i.employee_id, e.full_name as employee_name
  from task_submissions s join task_instances i on i.id = s.instance_id join task_templates t on t.id = i.template_id join employees e on e.id = i.employee_id`

type RawReview = Raw & { template_id: number; title: string; photo_criteria: string | null; employee_id: number; employee_name: string }
const hydrateReview = (db: Db, r: RawReview): ReviewRow => ({ ...r, ai_issues: JSON.parse(r.ai_issues) as string[], photos: listPhotos(db, r.id) })

export function listReviewQueue(db: Db): ReviewRow[] {
  const rows = db.prepare(`${reviewSelect} where s.decision = 'needs_review' order by s.created_at`).all() as RawReview[]
  return rows.map((r) => hydrateReview(db, r))
}

export function getReviewRow(db: Db, submissionId: number): ReviewRow | null {
  const r = db.prepare(`${reviewSelect} where s.id = ?`).get(submissionId) as RawReview | undefined
  return r ? hydrateReview(db, r) : null
}

export function listStaleAiPending(db: Db, beforeIso: string): Submission[] {
  const rows = db.prepare(`select ${cols} from task_submissions s where s.ai_status = 'pending' and s.created_at < ? order by s.id`).all(beforeIso) as Raw[]
  return rows.map(hydrate)
}

export function listPhotosOlderThan(db: Db, beforeIso: string): Photo[] {
  return db
    .prepare('select p.* from task_photos p join task_submissions s on s.id = p.submission_id where p.deleted_at is null and s.created_at < ? order by p.id')
    .all(beforeIso) as Photo[]
}

export function markPhotoDeleted(db: Db, id: number, nowIso: string): void {
  db.prepare('update task_photos set deleted_at = ? where id = ?').run(nowIso, id)
}
```

- [ ] **Step 8: Тесты зелёные, commit**

Run: `npx vitest run server/db` → все passed (включая старые `connect` и `repos`).
Run: `npm run typecheck` → чисто.

```bash
git add server/db server/test/fixtures.ts
git commit -m "feat: tasks migration and repositories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Сервис выдачи, callback-данные и клавиатуры

**Files:**
- Create: `server/bot/callbacks.ts`, `server/tasks/issue.ts`, `server/tasks/issue.test.ts`
- Modify: `server/bot/keyboards.ts`

**Interfaces:**
- Consumes: репозитории из Task 3, `Notifier`, `formatLocal`.
- Produces (`callbacks.ts`):
  ```ts
  CB = { open(id), done(id), photo(id), claim(id), accept(subId), reject(subId) }  // строки callback_data
  CB_RE = { open: /^task:open:(\d+)$/, done: /^task:done:(\d+)$/, photo: /^task:photo:(\d+)$/, claim: /^task:claim:(\d+)$/, accept: /^review:accept:(\d+)$/, reject: /^review:reject:(\d+)$/ }
  ```
- Produces (`keyboards.ts`): `BTN.photosDone = 'Готово'`, `BTN.cancel = 'Отмена'`; `openTaskKeyboard(instanceId): InlineKeyboard` («Открыть»), `claimKeyboard(instanceId)` («Беру»), `taskCardKeyboard(instanceId, requiresPhoto)` («Отправить фото» либо «Выполнено»), `photoCollectKeyboard(): Keyboard` («Готово» / «Отмена»), `cancelKeyboard(): Keyboard` («Отмена»), `reviewKeyboard(submissionId): InlineKeyboard` («Принять» / «Отклонить»).
- Produces (`issue.ts`):
  ```ts
  type IssueDeps = { db: Db; notifier: Notifier; tz: string }
  type IssueResult = { created: TaskInstance[]; notified: number }
  issueTemplate(deps: IssueDeps, template: TaskTemplate, slotAt: Date, now: Date): Promise<IssueResult>
  taskDueText(due: Date, tz: string, now: Date): string   // 'Срок: до 22:00'
  ```

- [ ] **Step 1: callbacks и клавиатуры**

`server/bot/callbacks.ts`:
```ts
export const CB = {
  open: (id: number) => `task:open:${id}`,
  done: (id: number) => `task:done:${id}`,
  photo: (id: number) => `task:photo:${id}`,
  claim: (id: number) => `task:claim:${id}`,
  accept: (submissionId: number) => `review:accept:${submissionId}`,
  reject: (submissionId: number) => `review:reject:${submissionId}`,
}

export const CB_RE = {
  open: /^task:open:(\d+)$/,
  done: /^task:done:(\d+)$/,
  photo: /^task:photo:(\d+)$/,
  claim: /^task:claim:(\d+)$/,
  accept: /^review:accept:(\d+)$/,
  reject: /^review:reject:(\d+)$/,
}
```

`server/bot/keyboards.ts`, добавить:
```ts
import { InlineKeyboard, Keyboard } from 'grammy'
import { CB } from './callbacks.js'

export const BTN = {
  tasks: 'Мои задания',
  learning: 'Обучение',
  quizzes: 'Тесты',
  rating: 'Мой рейтинг',
  summary: 'Сводка',
  photosDone: 'Готово',
  cancel: 'Отмена',
} as const

export const openTaskKeyboard = (id: number) => new InlineKeyboard().text('Открыть', CB.open(id))
export const claimKeyboard = (id: number) => new InlineKeyboard().text('Беру', CB.claim(id))
export const taskCardKeyboard = (id: number, requiresPhoto: boolean) =>
  requiresPhoto
    ? new InlineKeyboard().text('Отправить фото', CB.photo(id))
    : new InlineKeyboard().text('Выполнено', CB.done(id))
export const photoCollectKeyboard = () => new Keyboard().text(BTN.photosDone).text(BTN.cancel).resized()
export const cancelKeyboard = () => new Keyboard().text(BTN.cancel).resized()
export const reviewKeyboard = (submissionId: number) =>
  new InlineKeyboard().text('Принять', CB.accept(submissionId)).text('Отклонить', CB.reject(submissionId))
```
(Существующие `employeeMenu`, `ownerMenu`, `contactRequest` остаются.)

- [ ] **Step 2: Тест выдачи**

`server/tasks/issue.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { listInstances, listOffers } from '../db/taskInstances.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { issueTemplate } from './issue.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
const now = new Date('2026-09-07T19:00:00.000Z')

const input = (over: Partial<TaskTemplateInput>): TaskTemplateInput => ({
  title: 'Убрать стулья с улицы',
  description: '',
  requires_photo: true,
  photo_criteria: 'Стульев на улице нет',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  schedule: null,
  deadline_minutes: 60,
  position_ids: [],
  employee_ids: [],
  ...over,
})

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  log = []
})

describe('issueTemplate', () => {
  it('each: one pending instance per eligible employee, each notified with an Open button', async () => {
    const t = createTaskTemplate(db, input({ position_ids: [seed.positions.barista.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r.created).toHaveLength(2)
    expect(r.notified).toBe(2)
    expect(r.created[0]).toMatchObject({ status: 'pending', due_at: '2026-09-07T20:00:00.000Z', slot_at: now.toISOString() })
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toContain('Убрать стулья с улицы')
    expect(log[0]!.text).toContain('до 23:00')
  })

  it('each: re-issuing the same slot creates nothing', async () => {
    const t = createTaskTemplate(db, input({ position_ids: [seed.positions.barista.id] }), null)
    const deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }
    await issueTemplate(deps, t, now, now)
    const again = await issueTemplate(deps, t, now, now)
    expect(again.created).toEqual([])
    expect(again.notified).toBe(0)
    expect(listInstances(db, {})).toHaveLength(2)
  })

  it('shared: one open instance and an offer per employee', async () => {
    const t = createTaskTemplate(db, input({ distribution: 'shared', position_ids: [seed.positions.barista.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r.created).toHaveLength(1)
    expect(r.created[0]).toMatchObject({ status: 'open', employee_id: null })
    expect(listOffers(db, r.created[0]!.id).map((o) => o.telegram_id).sort()).toEqual([500, 501])
    expect(log[0]!.text).toMatch(/Кто возьмёт/)
  })

  it('does nothing when nobody is eligible', async () => {
    const t = createTaskTemplate(db, input({ assignee_mode: 'by_employees', employee_ids: [seed.employees.olga.id] }), null)
    const r = await issueTemplate({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' }, t, now, now)
    expect(r).toEqual({ created: [], notified: 0 })
  })
})
```

Run: `npx vitest run server/tasks/issue.test.ts` → FAIL (модуль не найден).

- [ ] **Step 3: server/tasks/issue.ts**

```ts
import type { Db } from '../db/connect.js'
import { eligibleEmployees, type TaskTemplate } from '../db/taskTemplates.js'
import { addOffer, createInstance, type TaskInstance } from '../db/taskInstances.js'
import { formatLocal } from '../lib/time.js'
import type { Notifier } from '../notify.js'
import { claimKeyboard, openTaskKeyboard } from '../bot/keyboards.js'

export type IssueDeps = { db: Db; notifier: Notifier; tz: string }
export type IssueResult = { created: TaskInstance[]; notified: number }

export function taskDueText(due: Date, tz: string, now: Date): string {
  return `Срок: до ${formatLocal(due, tz, now)}`
}

export async function issueTemplate(deps: IssueDeps, template: TaskTemplate, slotAt: Date, now: Date): Promise<IssueResult> {
  const { db, notifier, tz } = deps
  const employees = eligibleEmployees(db, template)
  if (employees.length === 0) return { created: [], notified: 0 }

  const due = new Date(slotAt.getTime() + template.deadline_minutes * 60_000)
  const base = { template_id: template.id, slot_at: slotAt.toISOString(), issued_at: now.toISOString(), due_at: due.toISOString() }
  const dueText = taskDueText(due, tz, now)
  const created: TaskInstance[] = []
  let notified = 0

  if (template.distribution === 'each') {
    for (const e of employees) {
      const inst = createInstance(db, { ...base, employee_id: e.id, status: 'pending' })
      if (!inst) continue
      created.push(inst)
      if (e.telegram_id === null) continue
      const id = await notifier.toEmployee(e.telegram_id, `Новое задание: ${template.title}\n${dueText}`, {
        keyboard: openTaskKeyboard(inst.id),
      })
      if (id !== null) notified++
    }
    return { created, notified }
  }

  const inst = createInstance(db, { ...base, employee_id: null, status: 'open' })
  if (!inst) return { created: [], notified: 0 }
  created.push(inst)
  for (const e of employees) {
    if (e.telegram_id === null) continue
    const id = await notifier.toEmployee(e.telegram_id, `Задание для команды: ${template.title}\n${dueText}\nКто возьмёт?`, {
      keyboard: claimKeyboard(inst.id),
    })
    if (id !== null) {
      addOffer(db, inst.id, e.telegram_id, id)
      notified++
    }
  }
  return { created, notified }
}
```

Run: `npx vitest run server/tasks/issue.test.ts` → 4 passed.

- [ ] **Step 4: Commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/bot/callbacks.ts server/bot/keyboards.ts server/tasks/issue.ts server/tasks/issue.test.ts
git commit -m "feat: task issuing service, callback data and keyboards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: API шаблонов, журнала и файлов

**Files:**
- Create: `server/api/tasks.ts`, `server/api/tasks.test.ts`, `server/api/uploads.ts`
- Modify: `server/app.ts` (новые поля `AppDeps`, регистрация), `server/test/buildTestApp.ts`, `server/index.ts`

**Interfaces:**
- Consumes: репозитории Task 3, `scheduleSchema`, `nextRun`, `issueTemplate`.
- Produces `AppDeps` = `{ config; db; auth; notifier; uploadsDir: string; adminDistDir? }` (tz берётся из `config.TZ`).
- Produces HTTP (все за сессией):
  - `GET /api/tasks/templates?includeInactive=1` → `TaskTemplate[]`.
  - `POST /api/tasks/templates` тело `TemplateBody` → 201 `{ template: TaskTemplate; issued: { created: number; notified: number } | null }` (issued только для разовых).
  - `GET /api/tasks/templates/:id` → `TaskTemplate` / 404. `PATCH /api/tasks/templates/:id` тело `TemplateBody` → `TaskTemplate` / 404.
  - `POST /api/tasks/templates/:id/deactivate` и `/activate` → `TaskTemplate` / 404.
  - `GET /api/tasks/instances?status&employee_id&template_id&from&to` → `InstanceRow[]`.
  - `GET /api/tasks/instances/:id` → `{ instance: InstanceRow; submissions: (Submission & { photos: Photo[] })[] }` / 404.
  - `GET /api/uploads/<path>` → файл из `uploadsDir` (401 без сессии, 404 JSON если нет).
  - Ошибки валидации 400 `{ error: 'validation', issues }`.
- `TemplateBody` (zod): `title` 1..200, `description` ≤ 2000 (по умолчанию ''), `requires_photo` boolean, `photo_criteria` string|null (обязательна и непуста при `requires_photo`), `auto_accept_threshold` int 0..100 (по умолчанию 80), `assignee_mode`, `distribution`, `position_ids` number[], `employee_ids` number[] (непусты соответственно режиму), `schedule` `scheduleSchema | null`, `deadline_minutes` int ≥ 5.
- `buildTestApp()` дополнительно возвращает `uploadsDir` (временная папка, чистится в `afterAll`? нет: каждая сборка создаёт свою `mkdtemp`, тесты сами не чистят, папки в системном tmp).

- [ ] **Step 1: Тесты API**

`server/api/tasks.test.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'

async function setup() {
  const t = await buildTestApp()
  const seed = seedRestaurant(t.db)
  const cookie = await t.loginAsOwner()
  return { ...t, seed, h: { cookie } }
}

const weeklyBody = (seed: ReturnType<typeof seedRestaurant>) => ({
  title: 'Помыть кофемашину',
  description: 'Группы, холдеры, поддон',
  requires_photo: true,
  photo_criteria: 'Группы чистые, поддон пустой',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  position_ids: [seed.positions.barista.id],
  employee_ids: [],
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60,
})

describe('task templates api', () => {
  it('creates a weekly template with next_run_at and lists it', async () => {
    const { app, seed, h } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    expect(res.statusCode).toBe(201)
    const { template, issued } = res.json()
    expect(template).toMatchObject({ id: 1, active: true, position_ids: [seed.positions.barista.id] })
    expect(template.next_run_at).toMatch(/T19:00:00\.000Z$/)
    expect(issued).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/api/tasks/templates', headers: h })
    expect(list.json()).toHaveLength(1)
  })

  it('validates criteria, assignees and schedule', async () => {
    const { app, seed, h } = await setup()
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload })
    expect((await post({ ...weeklyBody(seed), photo_criteria: '' })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), position_ids: [] })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), schedule: { kind: 'weekly', days: [], times: ['10:00'] } })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), deadline_minutes: 1 })).statusCode).toBe(400)
    const ok = await post({ ...weeklyBody(seed), requires_photo: false, photo_criteria: null })
    expect(ok.statusCode).toBe(201)
  })

  it('a one-off template is issued immediately and shows up in the journal', async () => {
    const { app, seed, h, notifications } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: { ...weeklyBody(seed), schedule: null } })
    expect(res.statusCode).toBe(201)
    expect(res.json().issued).toEqual({ created: 2, notified: 2 })
    expect(res.json().template.next_run_at).toBeNull()
    expect(notifications.filter((n) => typeof n.to === 'number')).toHaveLength(2)

    const list = await app.inject({ method: 'GET', url: '/api/tasks/instances?status=pending', headers: h })
    expect(list.json()).toHaveLength(2)
    expect(list.json()[0]).toMatchObject({ title: 'Помыть кофемашину', status: 'pending' })
    const one = await app.inject({ method: 'GET', url: `/api/tasks/instances/${list.json()[0].id}`, headers: h })
    expect(one.json()).toMatchObject({ instance: { status: 'pending' }, submissions: [] })
    const byEmployee = await app.inject({ method: 'GET', url: `/api/tasks/instances?employee_id=${seed.employees.petr.id}`, headers: h })
    expect(byEmployee.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/tasks/instances/999', headers: h })).statusCode).toBe(404)
  })

  it('updates, deactivates and reactivates', async () => {
    const { app, seed, h } = await setup()
    await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    const upd = await app.inject({ method: 'PATCH', url: '/api/tasks/templates/1', headers: h, payload: { ...weeklyBody(seed), title: 'Кофемашина', distribution: 'shared' } })
    expect(upd.json()).toMatchObject({ title: 'Кофемашина', distribution: 'shared' })
    const off = await app.inject({ method: 'POST', url: '/api/tasks/templates/1/deactivate', headers: h })
    expect(off.json()).toMatchObject({ active: false, next_run_at: null })
    expect((await app.inject({ method: 'GET', url: '/api/tasks/templates', headers: h })).json()).toEqual([])
    const on = await app.inject({ method: 'POST', url: '/api/tasks/templates/1/activate', headers: h })
    expect(on.json().active).toBe(true)
    expect(on.json().next_run_at).toMatch(/Z$/)
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/templates/9', headers: h, payload: weeklyBody(seed) })).statusCode).toBe(404)
  })

  it('requires a session', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/tasks/templates' })).statusCode).toBe(401)
  })
})

describe('uploads', () => {
  it('serves files only with a session', async () => {
    const { app, h, uploadsDir } = await setup()
    mkdirSync(join(uploadsDir, '7'), { recursive: true })
    writeFileSync(join(uploadsDir, '7', 'a.jpg'), 'jpegdata')
    const ok = await app.inject({ method: 'GET', url: '/api/uploads/7/a.jpg', headers: h })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toBe('jpegdata')
    expect((await app.inject({ method: 'GET', url: '/api/uploads/7/a.jpg' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/uploads/7/missing.jpg', headers: h })).statusCode).toBe(404)
  })
})
```

Run: `npx vitest run server/api/tasks.test.ts` → FAIL.

- [ ] **Step 2: server/api/uploads.ts**

```ts
import type { FastifyPluginAsync } from 'fastify'
import fastifyStatic from '@fastify/static'

export const uploadRoutes: FastifyPluginAsync<{ uploadsDir: string }> = async (app, { uploadsDir }) => {
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/api/uploads/',
    decorateReply: false,
    index: false,
    list: false,
  })
}
```

- [ ] **Step 3: server/api/tasks.ts**

```ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  createTaskTemplate, getTaskTemplate, listTaskTemplates, setTemplateActive, updateTaskTemplate, type TaskTemplateInput,
} from '../db/taskTemplates.js'
import { getInstanceRow, listInstances } from '../db/taskInstances.js'
import { listSubmissionsForInstance } from '../db/taskSubmissions.js'
import { idParams, parse } from '../lib/validate.js'
import type { Notifier } from '../notify.js'
import { issueTemplate } from '../tasks/issue.js'
import { nextRun, scheduleSchema } from '../tasks/schedule.js'

type Opts = { db: Db; notifier: Notifier; tz: string; now?: () => Date }

const templateBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(''),
    requires_photo: z.boolean(),
    photo_criteria: z.string().trim().max(2000).nullable().default(null),
    auto_accept_threshold: z.number().int().min(0).max(100).default(80),
    assignee_mode: z.enum(['by_position', 'by_employees']),
    distribution: z.enum(['each', 'shared']),
    position_ids: z.array(z.number().int().positive()).default([]),
    employee_ids: z.array(z.number().int().positive()).default([]),
    schedule: scheduleSchema.nullable(),
    deadline_minutes: z.number().int().min(5),
  })
  .superRefine((b, ctx) => {
    if (b.requires_photo && !b.photo_criteria) {
      ctx.addIssue({ code: 'custom', path: ['photo_criteria'], message: 'Опишите критерии для фото' })
    }
    if (b.assignee_mode === 'by_position' && b.position_ids.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['position_ids'], message: 'Выберите хотя бы одну должность' })
    }
    if (b.assignee_mode === 'by_employees' && b.employee_ids.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['employee_ids'], message: 'Выберите хотя бы одного сотрудника' })
    }
  })

const listQuery = z.object({ includeInactive: z.string().optional() })
const instancesQuery = z.object({
  status: z.enum(['open', 'pending', 'submitted', 'review', 'accepted', 'overdue']).optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  template_id: z.coerce.number().int().positive().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

export const taskRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, notifier, tz } = opts
  const now = opts.now ?? (() => new Date())
  const toInput = (b: z.infer<typeof templateBody>): TaskTemplateInput => ({ ...b, photo_criteria: b.requires_photo ? b.photo_criteria : null })
  const nextRunFor = (input: TaskTemplateInput): string | null => (input.schedule ? nextRun(input.schedule, now(), tz).toISOString() : null)

  app.get('/api/tasks/templates', async (req) => {
    const q = parse(listQuery, req.query)
    return listTaskTemplates(db, { includeInactive: q.includeInactive === '1' })
  })

  app.post('/api/tasks/templates', async (req, reply) => {
    const input = toInput(parse(templateBody, req.body))
    const template = createTaskTemplate(db, input, nextRunFor(input))
    let issued: { created: number; notified: number } | null = null
    if (!input.schedule) {
      const t = now()
      const r = await issueTemplate({ db, notifier, tz }, template, t, t)
      issued = { created: r.created.length, notified: r.notified }
    }
    return reply.code(201).send({ template, issued })
  })

  app.get('/api/tasks/templates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return getTaskTemplate(db, id) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.patch('/api/tasks/templates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const input = toInput(parse(templateBody, req.body))
    const current = getTaskTemplate(db, id)
    if (!current) return reply.code(404).send({ error: 'not_found' })
    const updated = updateTaskTemplate(db, id, input, current.active ? nextRunFor(input) : null)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/tasks/templates/:id/deactivate', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setTemplateActive(db, id, false, null) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/tasks/templates/:id/activate', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const t = getTaskTemplate(db, id)
    if (!t) return reply.code(404).send({ error: 'not_found' })
    return setTemplateActive(db, id, true, t.schedule ? nextRun(t.schedule, now(), tz).toISOString() : null)
  })

  app.get('/api/tasks/instances', async (req) => listInstances(db, parse(instancesQuery, req.query)))

  app.get('/api/tasks/instances/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const instance = getInstanceRow(db, id)
    if (!instance) return reply.code(404).send({ error: 'not_found' })
    return { instance, submissions: listSubmissionsForInstance(db, id) }
  })
}
```

- [ ] **Step 4: app.ts, buildTestApp, index.ts**

`server/app.ts`: `AppDeps` получает `uploadsDir: string`; импорт `taskRoutes` и `uploadRoutes`; в защищённом scope:
```ts
    scope.register(positionRoutes, { db })
    scope.register(employeeRoutes, { db })
    scope.register(taskRoutes, { db, notifier, tz: config.TZ })
    scope.register(uploadRoutes, { uploadsDir: deps.uploadsDir })
```

`server/test/buildTestApp.ts`: создать `const uploadsDir = mkdtempSync(join(tmpdir(), 'uploads-'))` (импорты `mkdtempSync` из `node:fs`, `tmpdir` из `node:os`, `join` из `node:path`), передать в `buildApp`, вернуть в результате. В `server/app.test.ts` в тесте статики тоже передать `uploadsDir: mkdtempSync(join(tmpdir(), 'uploads-'))`.

`server/index.ts`: `const uploadsDir = join(config.DATA_DIR, 'uploads'); mkdirSync(uploadsDir, { recursive: true })` и передать `uploadsDir` в `buildApp`.

- [ ] **Step 5: Зелёные, commit**

Run: `npx vitest run server/api/tasks.test.ts` → 6 passed. Run: `npm test && npm run typecheck` → зелёные.

```bash
git add -A
git commit -m "feat: task templates, journal and uploads API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Бот сотрудника: список, карточка, фото, «Беру»

**Files:**
- Modify: `server/bot/deps.ts`, `server/bot/createBot.ts`, `server/test/bot.ts`
- Create: `server/bot/files.ts`, `server/bot/tasks.ts`, `server/bot/tasks.test.ts`

**Interfaces:**
- Consumes: репозитории Task 3, `CB`/`CB_RE`, клавиатуры Task 4, `taskDueText`, `getState`/`setState`/`clearState`.
- Produces `BotDeps` += `{ uploadsDir: string; downloadFile: (filePath: string) => Promise<Buffer>; onSubmission: (submissionId: number) => void; now: () => Date }`.
- Produces `telegramDownloader(token: string): (filePath: string) => Promise<Buffer>` (`server/bot/files.ts`).
- Produces `registerTasks(bot, deps)`; состояние сотрудника `{ kind: 'collecting_photos'; instance_id: number; photos: { path: string; fileUniqueId: string }[] }` (тип `CollectingState`, экспортируется).
- Produces `makeBot(db, overrides?, responders?)` (третий аргумент прокидывается в `captureApi`).
- Тексты (используются в тестах): «Активных заданий нет.», «Это не ваше задание.», «Задание уже не активно.», «Уже взяли.», «Пришлите до 3 фото, потом нажмите Готово.», «Сначала откройте задание и нажмите «Отправить фото».», «Максимум 3 фото.», «Это фото уже отправляли, снимите заново.», «Фото N из 3 получено.», «Нужно хотя бы одно фото.», «Проверяю, это займёт до минуты.», «Отменено.», «Принято! Задание выполнено.», «Взял(а) <имя>».

- [ ] **Step 1: deps, files, makeBot**

`server/bot/deps.ts`:
```ts
import type { Db } from '../db/connect.js'
import type { Notifier } from '../notify.js'

export type BotDeps = {
  db: Db
  ownerPhone: string
  publicUrl?: string
  notifier: Notifier
  tz: string
  uploadsDir: string
  downloadFile: (filePath: string) => Promise<Buffer>
  onSubmission: (submissionId: number) => void
  now: () => Date
}
```

`server/bot/files.ts`:
```ts
export function telegramDownloader(token: string): (filePath: string) => Promise<Buffer> {
  return async (filePath) => {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
```

`server/test/bot.ts`: добавить параметр `responders: Record<string, (p: Record<string, unknown>) => unknown> = {}` третьим аргументом и передать его в оба `captureApi`; в `deps` по умолчанию:
```ts
    uploadsDir: mkdtempSync(join(tmpdir(), 'bot-uploads-')),
    downloadFile: async () => Buffer.from('fake-jpeg'),
    onSubmission: () => undefined,
    now: () => new Date('2026-09-07T19:00:00.000Z'),
```
(импорты `mkdtempSync` из `node:fs`, `tmpdir` из `node:os`, `join` из `node:path`).

`server/bot/createBot.ts`: между `registerLinking` и `registerFallback` вызвать `registerTasks(bot, deps)`.

- [ ] **Step 2: Тесты**

`server/bot/tasks.test.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { createInstance, addOffer, getInstance, getInstanceRow } from '../db/taskInstances.js'
import { createTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { getSubmission, listPhotos } from '../db/taskSubmissions.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { callbackUpdate, photoUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'

const NOW = '2026-09-07T19:00:00.000Z'
const DUE = '2026-09-07T20:00:00.000Z'
let db: Db
let bot: Bot
let calls: ApiCall[]
let uploadsDir: string
let submitted: number[]
let seed: ReturnType<typeof seedRestaurant>

const tpl = (over: Partial<TaskTemplateInput> = {}): TaskTemplateInput => ({
  title: 'Помыть кофемашину', description: 'Группы и поддон', requires_photo: true, photo_criteria: 'Чисто',
  auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null,
  deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [], ...over,
})
const pendingFor = (templateId: number, employeeId: number) =>
  createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: NOW, issued_at: NOW, due_at: DUE, status: 'pending' })!

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))
const lastText = () => texts().at(-1) ?? ''
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  submitted = []
  const made = makeBot(db, { onSubmission: (id) => submitted.push(id) }, {
    getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'x', file_path: `photos/${String(p.file_id)}.jpg` }),
  })
  bot = made.bot
  calls = made.calls
  uploadsDir = made.deps.uploadsDir
})

describe('task list and card', () => {
  it('shows an empty list, then tasks with an Open button', async () => {
    await bot.handleUpdate(textUpdate(500, 'Мои задания'))
    expect(lastText()).toBe('Активных заданий нет.')
    const t = createTaskTemplate(db, tpl(), null)
    pendingFor(t.id, seed.employees.ivan.id)
    await bot.handleUpdate(textUpdate(500, 'Мои задания'))
    expect(lastText()).toContain('Помыть кофемашину')
    expect(lastText()).toContain('до 23:00')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.open(1))
  })

  it('opens a card, refuses foreign tasks, completes a no-photo task', async () => {
    const t = createTaskTemplate(db, tpl({ requires_photo: false, photo_criteria: null }), null)
    const inst = pendingFor(t.id, seed.employees.ivan.id)
    await bot.handleUpdate(callbackUpdate(501, CB.open(inst.id)))
    expect(lastAnswer()).toBe('Это не ваше задание.')
    await bot.handleUpdate(callbackUpdate(500, CB.open(inst.id)))
    expect(lastText()).toContain('Группы и поддон')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.done(inst.id))
    await bot.handleUpdate(callbackUpdate(500, CB.done(inst.id)))
    expect(lastText()).toBe('Принято! Задание выполнено.')
    expect(getInstance(db, inst.id)).toMatchObject({ status: 'accepted', completed_at: NOW })
    await bot.handleUpdate(callbackUpdate(500, CB.done(inst.id)))
    expect(lastAnswer()).toBe('Задание уже не активно.')
  })
})

describe('shared task claim', () => {
  it('first claimer wins, others see who took it', async () => {
    const t = createTaskTemplate(db, tpl({ distribution: 'shared' }), null)
    const inst = createInstance(db, { template_id: t.id, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: DUE, status: 'open' })!
    addOffer(db, inst.id, 500, 10)
    addOffer(db, inst.id, 501, 11)
    await bot.handleUpdate(callbackUpdate(500, CB.claim(inst.id), 10))
    expect(getInstanceRow(db, inst.id)).toMatchObject({ status: 'pending', employee_id: seed.employees.ivan.id })
    const edits = calls.filter((c) => c.method === 'editMessageText')
    expect(edits.some((c) => c.payload.chat_id === 501 && c.payload.message_id === 11 && String(c.payload.text).includes('Взял(а) Иван Петров'))).toBe(true)
    expect(lastText()).toContain('Помыть кофемашину')
    await bot.handleUpdate(callbackUpdate(501, CB.claim(inst.id), 11))
    expect(lastAnswer()).toBe('Уже взяли.')
  })
})

describe('photo collection', () => {
  let instId: number
  beforeEach(() => {
    const t = createTaskTemplate(db, tpl(), null)
    instId = pendingFor(t.id, seed.employees.ivan.id).id
  })

  it('needs the photo mode first', async () => {
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Сначала откройте задание и нажмите «Отправить фото».')
  })

  it('collects up to 3 photos, rejects duplicates, submits', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    expect(lastText()).toBe('Пришлите до 3 фото, потом нажмите Готово.')
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    expect(lastText()).toBe('Нужно хотя бы одно фото.')
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Фото 1 из 3 получено.')
    expect(calls.some((c) => c.method === 'getFile')).toBe(true)
    expect(readdirSync(join(uploadsDir, String(instId)))).toHaveLength(1)
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Это фото уже отправляли, снимите заново.')
    await bot.handleUpdate(photoUpdate(500, 'f2', 'u2'))
    await bot.handleUpdate(photoUpdate(500, 'f3', 'u3'))
    await bot.handleUpdate(photoUpdate(500, 'f4', 'u4'))
    expect(lastText()).toBe('Максимум 3 фото.')
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    expect(lastText()).toBe('Проверяю, это займёт до минуты.')
    expect(submitted).toEqual([1])
    const sub = getSubmission(db, 1)!
    expect(sub).toMatchObject({ instance_id: instId, ai_status: 'pending' })
    expect(listPhotos(db, 1)).toHaveLength(3)
    expect(getInstance(db, instId)?.status).toBe('submitted')
    expect(getState(db, 500)).toBeNull()
  })

  it('cancel removes files and state', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    const dir = join(uploadsDir, String(instId))
    expect(readdirSync(dir)).toHaveLength(1)
    await bot.handleUpdate(textUpdate(500, 'Отмена'))
    expect(lastText()).toBe('Отменено.')
    expect(getState(db, 500)).toBeNull()
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
    expect(getInstance(db, instId)?.status).toBe('pending')
  })
})
```

Run: `npx vitest run server/bot/tasks.test.ts` → FAIL (нет `registerTasks`).

- [ ] **Step 3: server/bot/tasks.ts**

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot, Context } from 'grammy'
import { clearState, getState, setState } from '../db/botStates.js'
import { claimInstance, getInstanceRow, listEmployeeInstances, listOffers, setInstanceStatus, type InstanceRow } from '../db/taskInstances.js'
import { getTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, photoExists } from '../db/taskSubmissions.js'
import { taskDueText } from '../tasks/issue.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { BTN, employeeMenu, openTaskKeyboard, photoCollectKeyboard, taskCardKeyboard } from './keyboards.js'
import { showHome } from './linking.js'
import { roleOf } from './roles.js'

export type CollectingState = {
  kind: 'collecting_photos'
  instance_id: number
  photos: { path: string; fileUniqueId: string }[]
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'ждёт выполнения',
  submitted: 'ждёт проверки',
  review: 'на проверке у владельца',
}

const collecting = (deps: BotDeps, telegramId: number): CollectingState | null => {
  const s = getState<CollectingState>(deps.db, telegramId)
  return s?.kind === 'collecting_photos' ? s : null
}

export function registerTasks(bot: Bot, deps: BotDeps): void {
  const { db } = deps

  function employeeOf(ctx: Context) {
    if (!ctx.from) return null
    const role = roleOf(db, ctx.from.id)
    return role.kind === 'employee' ? role.employee : null
  }

  async function sendCard(ctx: Context, row: InstanceRow): Promise<void> {
    const t = getTaskTemplate(db, row.template_id)
    const lines = [row.title]
    if (t?.description) lines.push(t.description)
    if (row.requires_photo && t?.photo_criteria) lines.push(`Что должно быть на фото: ${t.photo_criteria}`)
    lines.push(taskDueText(new Date(row.due_at), deps.tz, deps.now()))
    await ctx.reply(lines.join('\n'), { reply_markup: taskCardKeyboard(row.id, row.requires_photo) })
  }

  /** Возвращает экземпляр, если он принадлежит сотруднику и в статусе pending; иначе отвечает на callback и null. */
  async function ownPending(ctx: Context, id: number, employeeId: number): Promise<InstanceRow | null> {
    const row = getInstanceRow(db, id)
    if (!row || row.employee_id !== employeeId) {
      await ctx.answerCallbackQuery({ text: 'Это не ваше задание.' })
      return null
    }
    if (row.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: 'Задание уже не активно.' })
      return null
    }
    return row
  }

  bot.hears(BTN.tasks, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return showHome(ctx, deps)
    const rows = listEmployeeInstances(db, emp.id, ['pending', 'submitted', 'review'])
    if (rows.length === 0) {
      await ctx.reply('Активных заданий нет.', { reply_markup: employeeMenu() })
      return
    }
    for (const row of rows) {
      const text = `${row.title}\n${taskDueText(new Date(row.due_at), deps.tz, deps.now())}\nСтатус: ${STATUS_LABEL[row.status] ?? row.status}`
      await ctx.reply(text, row.status === 'pending' ? { reply_markup: openTaskKeyboard(row.id) } : undefined)
    }
  })

  bot.callbackQuery(CB_RE.open, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return ctx.answerCallbackQuery()
    const row = await ownPending(ctx, Number(ctx.match[1]), emp.id)
    if (!row) return
    await ctx.answerCallbackQuery()
    await sendCard(ctx, row)
  })

  bot.callbackQuery(CB_RE.done, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return ctx.answerCallbackQuery()
    const row = await ownPending(ctx, Number(ctx.match[1]), emp.id)
    if (!row) return
    if (row.requires_photo) return ctx.answerCallbackQuery({ text: 'Для этого задания нужно фото.' })
    setInstanceStatus(db, row.id, 'accepted', { completed_at: deps.now().toISOString() })
    await ctx.answerCallbackQuery()
    await ctx.reply('Принято! Задание выполнено.', { reply_markup: employeeMenu() })
  })

  bot.callbackQuery(CB_RE.photo, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return ctx.answerCallbackQuery()
    const row = await ownPending(ctx, Number(ctx.match[1]), emp.id)
    if (!row) return
    setState(db, ctx.from.id, { kind: 'collecting_photos', instance_id: row.id, photos: [] } satisfies CollectingState)
    await ctx.answerCallbackQuery()
    await ctx.reply('Пришлите до 3 фото, потом нажмите Готово.', { reply_markup: photoCollectKeyboard() })
  })

  bot.callbackQuery(CB_RE.claim, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return ctx.answerCallbackQuery()
    const id = Number(ctx.match[1])
    if (!claimInstance(db, id, emp.id, deps.now().toISOString())) {
      return ctx.answerCallbackQuery({ text: 'Уже взяли.' })
    }
    await ctx.answerCallbackQuery({ text: 'Задание ваше.' })
    const row = getInstanceRow(db, id)!
    for (const offer of listOffers(db, id)) {
      if (offer.telegram_id === ctx.from.id) continue
      await deps.notifier.editMessage(offer.telegram_id, offer.message_id, `${row.title}\nВзял(а) ${emp.full_name}`)
    }
    await sendCard(ctx, row)
  })

  bot.on('message:photo', async (ctx, next) => {
    const state = collecting(deps, ctx.from.id)
    if (!state) {
      if (!employeeOf(ctx)) return next()
      await ctx.reply('Сначала откройте задание и нажмите «Отправить фото».')
      return
    }
    if (state.photos.length >= 3) {
      await ctx.reply('Максимум 3 фото.')
      return
    }
    const best = ctx.message.photo.at(-1)!
    const dup = photoExists(db, best.file_unique_id) || state.photos.some((p) => p.fileUniqueId === best.file_unique_id)
    if (dup) {
      await ctx.reply('Это фото уже отправляли, снимите заново.')
      return
    }
    const file = await ctx.getFile()
    if (!file.file_path) throw new Error('telegram returned no file_path')
    const data = await deps.downloadFile(file.file_path)
    const n = state.photos.length + 1
    const rel = join(String(state.instance_id), `${deps.now().getTime()}-${n}.jpg`)
    mkdirSync(join(deps.uploadsDir, String(state.instance_id)), { recursive: true })
    writeFileSync(join(deps.uploadsDir, rel), data)
    state.photos.push({ path: rel, fileUniqueId: best.file_unique_id })
    setState(db, ctx.from.id, state)
    await ctx.reply(`Фото ${n} из 3 получено.`)
  })

  bot.hears(BTN.photosDone, async (ctx, next) => {
    const state = collecting(deps, ctx.from!.id)
    if (!state) return next()
    if (state.photos.length === 0) {
      await ctx.reply('Нужно хотя бы одно фото.')
      return
    }
    const row = getInstanceRow(db, state.instance_id)
    if (!row || row.status !== 'pending') {
      clearState(db, ctx.from!.id)
      await ctx.reply('Задание уже не активно.', { reply_markup: employeeMenu() })
      return
    }
    const submission = createSubmission(db, row.id, deps.now().toISOString(), state.photos)
    setInstanceStatus(db, row.id, 'submitted')
    clearState(db, ctx.from!.id)
    await ctx.reply('Проверяю, это займёт до минуты.', { reply_markup: employeeMenu() })
    deps.onSubmission(submission.id)
  })

  bot.hears(BTN.cancel, async (ctx, next) => {
    const state = collecting(deps, ctx.from!.id)
    if (!state) return next()
    for (const p of state.photos) rmSync(join(deps.uploadsDir, p.path), { force: true })
    clearState(db, ctx.from!.id)
    await ctx.reply('Отменено.', { reply_markup: employeeMenu() })
  })
}
```

- [ ] **Step 4: Зелёные, commit**

Run: `npx vitest run server/bot` → все passed (старые 13 + новые 6). Run: `npm test && npm run typecheck` → зелёные.

```bash
git add -A
git commit -m "feat(bot): employee task list, card, photo collection and shared claim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Проверка через Claude, решения, фоновая очередь

**Files:**
- Create: `server/ai/photoReview.ts`, `server/ai/photoReview.test.ts`, `server/tasks/decide.ts`, `server/tasks/decide.test.ts`, `server/tasks/reviewQueue.ts`, `server/tasks/reviewQueue.test.ts`

**Interfaces:**
- Produces (`photoReview.ts`):
  ```ts
  type ReviewInput = { photos: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }[]; title: string; description: string; criteria: string }
  type ReviewResult = { score: number; verdict: string; issues: string[] }
  type Reviewer = (input: ReviewInput) => Promise<ReviewResult>
  SYSTEM_PROMPT: string
  buildMessages(input: ReviewInput): Anthropic.MessageParam[]
  reviewPhotos(input: ReviewInput, deps: { client: Anthropic; model: string }): Promise<ReviewResult>
  createReviewer(apiKey: string, model: string): Reviewer
  ```
- Produces (`decide.ts`):
  ```ts
  decideByScore(score: number, threshold: number): 'auto_accepted' | 'needs_review'
  type DecisionDeps = { db: Db; notifier: Notifier; tz: string }
  type OwnerDecisionResult = { ok: true; instanceId: number } | { ok: false; reason: 'not_found' | 'already_decided' }
  applyOwnerDecision(deps, submissionId: number, decision: 'accept' | 'reject', comment: string | null, now: Date): Promise<OwnerDecisionResult>
  ownerReviewCaption(row: ReviewRow): string      // текст для владельца, ≤ 1000 символов
  ```
- Produces (`reviewQueue.ts`):
  ```ts
  type ReviewQueue = { enqueue(submissionId: number): void; size(): number; idle(): Promise<void> }
  type ReviewQueueDeps = { db: Db; notifier: Notifier; tz: string; uploadsDir: string; reviewer: Reviewer; concurrency?: number; now?: () => Date }
  createReviewQueue(deps: ReviewQueueDeps): ReviewQueue
  ```

- [ ] **Step 1: Тест модуля Claude**

`server/ai/photoReview.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { buildMessages, reviewPhotos, SYSTEM_PROMPT, type ReviewInput } from './photoReview.js'

const input: ReviewInput = {
  photos: [
    { data: Buffer.from('a'), mediaType: 'image/jpeg' },
    { data: Buffer.from('b'), mediaType: 'image/jpeg' },
    { data: Buffer.from('c'), mediaType: 'image/png' },
  ],
  title: 'Помыть кофемашину',
  description: 'Группы и поддон',
  criteria: 'Группы чистые, поддон пустой',
}

function fakeClient(parsed: unknown) {
  const parse = vi.fn(async () => ({ parsed_output: parsed }))
  return { client: { messages: { parse } } as unknown as Anthropic, parse }
}

describe('buildMessages', () => {
  it('sends every photo as an image block followed by the task text', () => {
    const [msg] = buildMessages(input)
    const content = msg!.content as Anthropic.ContentBlockParam[]
    expect(content).toHaveLength(4)
    expect(content.slice(0, 3).every((b) => b.type === 'image')).toBe(true)
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('a').toString('base64') } })
    expect(content[3]).toMatchObject({ type: 'text' })
    const text = (content[3] as { text: string }).text
    expect(text).toContain('Помыть кофемашину')
    expect(text).toContain('Группы чистые, поддон пустой')
  })
})

describe('reviewPhotos', () => {
  it('passes model, cached system prompt and structured output, returns parsed result', async () => {
    const { client, parse } = fakeClient({ score: 87, verdict: 'Чисто', issues: [] })
    const result = await reviewPhotos(input, { client, model: 'claude-sonnet-5' })
    expect(result).toEqual({ score: 87, verdict: 'Чисто', issues: [] })
    const params = parse.mock.calls[0]![0] as Record<string, unknown>
    expect(params.model).toBe('claude-sonnet-5')
    expect(JSON.stringify(params.system)).toContain(SYSTEM_PROMPT.slice(0, 40))
    expect(JSON.stringify(params.system)).toContain('ephemeral')
    expect(params.output_config).toMatchObject({ effort: 'low' })
    expect((params.output_config as { format?: unknown }).format).toBeDefined()
  })

  it('throws when the model returned nothing parseable', async () => {
    const { client } = fakeClient(null)
    await expect(reviewPhotos(input, { client, model: 'm' })).rejects.toThrow(/structured/)
  })
})
```

Run: `npx vitest run server/ai` → FAIL.

- [ ] **Step 2: server/ai/photoReview.ts**

```ts
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

export type ReviewInput = {
  photos: { data: Buffer; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }[]
  title: string
  description: string
  criteria: string
}
export type ReviewResult = { score: number; verdict: string; issues: string[] }
export type Reviewer = (input: ReviewInput) => Promise<ReviewResult>

export const reviewSchema = z.object({
  score: z.number().int().min(0).max(100),
  verdict: z.string().max(300),
  issues: z.array(z.string().max(200)).max(10),
})

export const SYSTEM_PROMPT = `Ты проверяющий в ресторане. Сотрудник выполнил задание и прислал фото-отчёт.
Оцени по фото, насколько выполнены критерии задания, по шкале от 0 до 100:
100 — все критерии выполнены и это видно на фото; около 80 — есть мелкие замечания;
ниже 50 — существенные нарушения или по фото нельзя судить о ключевых критериях.
Если какой-то критерий не виден ни на одном фото, снижай балл и назови это в issues.
Не додумывай то, чего нет на снимках. Отвечай по-русски, коротко: verdict одной-двумя фразами,
issues — список конкретных замечаний (пустой, если всё в порядке).`

export function buildMessages(input: ReviewInput): Anthropic.MessageParam[] {
  const images: Anthropic.ImageBlockParam[] = input.photos.map((p) => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') },
  }))
  const text: Anthropic.TextBlockParam = {
    type: 'text',
    text: [
      `Задание: ${input.title}`,
      input.description ? `Описание: ${input.description}` : '',
      `Критерии для фото: ${input.criteria}`,
      `Фото в отчёте: ${input.photos.length}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
  return [{ role: 'user', content: [...images, text] }]
}

export async function reviewPhotos(input: ReviewInput, deps: { client: Anthropic; model: string }): Promise<ReviewResult> {
  const response = await deps.client.messages.parse(
    {
      model: deps.model,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: zodOutputFormat(reviewSchema) },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: buildMessages(input),
    },
    { timeout: 60_000 },
  )
  if (!response.parsed_output) throw new Error('claude returned no structured output')
  return response.parsed_output
}

export function createReviewer(apiKey: string, model: string): Reviewer {
  const client = new Anthropic({ apiKey })
  return (input) => reviewPhotos(input, { client, model })
}
```

Если `zodOutputFormat` из `@anthropic-ai/sdk/helpers/zod` не принимает zod 4 (ошибка типов или рантайма), замените на явную JSON-схему: `format: { type: 'json_schema', schema: z.toJSONSchema(reviewSchema) }` в `client.messages.create`, а результат берите из первого текстового блока: `reviewSchema.parse(JSON.parse(text))`. Зафиксируйте отклонение в отчёте.

Run: `npx vitest run server/ai` → 3 passed.

- [ ] **Step 3: Тест decide**

`server/tasks/decide.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, saveAiResult, getReviewRow } from '../db/taskSubmissions.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { applyOwnerDecision, decideByScore, ownerReviewCaption } from './decide.js'

const NOW = '2026-09-07T19:00:00.000Z'
let db: Db
let log: Notification[]
let subId: number
let instId: number

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  log = []
  const t = createTaskTemplate(db, {
    title: 'Разобрать поставку кофе', description: '', requires_photo: true, photo_criteria: 'Коробки разобраны, пакеты на полке',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60,
    position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  instId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'review' })!.id
  subId = createSubmission(db, instId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }]).id
  saveAiResult(db, subId, { score: 60, verdict: 'Часть коробок не разобрана', issues: ['коробки у входа'] }, 'needs_review', NOW)
})

describe('decideByScore', () => {
  it('accepts at or above the threshold only', () => {
    expect(decideByScore(80, 80)).toBe('auto_accepted')
    expect(decideByScore(79, 80)).toBe('needs_review')
    expect(decideByScore(100, 100)).toBe('auto_accepted')
  })
})

describe('applyOwnerDecision', () => {
  const deps = () => ({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' })

  it('accept closes the instance and tells the employee', async () => {
    const r = await applyOwnerDecision(deps(), subId, 'accept', null, new Date(NOW))
    expect(r).toEqual({ ok: true, instanceId: instId })
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_accepted', decided_at: NOW })
    expect(getInstance(db, instId)).toMatchObject({ status: 'accepted', completed_at: NOW })
    expect(log).toEqual([{ to: 500, text: expect.stringContaining('принято') }])
  })

  it('reject reopens the instance with the comment', async () => {
    const r = await applyOwnerDecision(deps(), subId, 'reject', 'Коробки у входа остались', new Date(NOW))
    expect(r.ok).toBe(true)
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_rejected', owner_comment: 'Коробки у входа остались' })
    expect(getInstance(db, instId)?.status).toBe('pending')
    expect(log[0]!.text).toContain('Коробки у входа остались')
  })

  it('second decision and unknown id are refused', async () => {
    await applyOwnerDecision(deps(), subId, 'accept', null, new Date(NOW))
    expect(await applyOwnerDecision(deps(), subId, 'reject', 'x', new Date(NOW))).toEqual({ ok: false, reason: 'already_decided' })
    expect(await applyOwnerDecision(deps(), 999, 'accept', null, new Date(NOW))).toEqual({ ok: false, reason: 'not_found' })
  })

  it('caption mentions task, employee, score and issues', () => {
    const cap = ownerReviewCaption(getReviewRow(db, subId)!)
    expect(cap).toContain('Разобрать поставку кофе')
    expect(cap).toContain('Иван Петров')
    expect(cap).toContain('60')
    expect(cap).toContain('коробки у входа')
    expect(cap.length).toBeLessThanOrEqual(1000)
  })
})
```

Run: `npx vitest run server/tasks/decide.test.ts` → FAIL.

- [ ] **Step 4: server/tasks/decide.ts**

```ts
import type { Db } from '../db/connect.js'
import { getEmployee } from '../db/employees.js'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getReviewRow, setOwnerDecision, type ReviewRow } from '../db/taskSubmissions.js'
import type { Notifier } from '../notify.js'
import { openTaskKeyboard } from '../bot/keyboards.js'

export function decideByScore(score: number, threshold: number): 'auto_accepted' | 'needs_review' {
  return score >= threshold ? 'auto_accepted' : 'needs_review'
}

export type DecisionDeps = { db: Db; notifier: Notifier; tz: string }
export type OwnerDecisionResult = { ok: true; instanceId: number } | { ok: false; reason: 'not_found' | 'already_decided' }

export async function applyOwnerDecision(
  deps: DecisionDeps, submissionId: number, decision: 'accept' | 'reject', comment: string | null, now: Date,
): Promise<OwnerDecisionResult> {
  const { db, notifier } = deps
  const row = getReviewRow(db, submissionId)
  if (!row) return { ok: false, reason: 'not_found' }
  const ok = setOwnerDecision(db, submissionId, decision === 'accept' ? 'owner_accepted' : 'owner_rejected', comment, now.toISOString())
  if (!ok) return { ok: false, reason: 'already_decided' }

  const employee = getEmployee(db, row.employee_id)
  if (decision === 'accept') {
    setInstanceStatus(db, row.instance_id, 'accepted', { completed_at: now.toISOString() })
    if (employee?.telegram_id) await notifier.toEmployee(employee.telegram_id, `Задание «${row.title}» принято владельцем.`)
  } else {
    setInstanceStatus(db, row.instance_id, 'pending')
    if (employee?.telegram_id) {
      await notifier.toEmployee(
        employee.telegram_id,
        `Задание «${row.title}» не принято: ${comment ?? 'без комментария'}.\nПереснимите и отправьте снова.`,
        { keyboard: openTaskKeyboard(row.instance_id) },
      )
    }
  }
  return { ok: true, instanceId: row.instance_id }
}

export function ownerReviewCaption(row: ReviewRow): string {
  const lines = [`Проверка: ${row.title}`, `Сотрудник: ${row.employee_name}`]
  if (row.ai_status === 'done' && row.ai_score !== null) {
    lines.push(`Оценка ИИ: ${row.ai_score} из 100`)
    if (row.ai_verdict) lines.push(row.ai_verdict)
    if (row.ai_issues.length) lines.push('Замечания: ' + row.ai_issues.join('; '))
  } else {
    lines.push('ИИ недоступен, проверьте вручную.')
  }
  const text = lines.join('\n')
  return text.length > 1000 ? text.slice(0, 997) + '…' : text
}
```

Run: `npx vitest run server/tasks/decide.test.ts` → 5 passed.

- [ ] **Step 5: Тест очереди**

`server/tasks/reviewQueue.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission } from '../db/taskSubmissions.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import type { ReviewInput, ReviewResult } from '../ai/photoReview.js'
import { createReviewQueue } from './reviewQueue.js'

const NOW = new Date('2026-09-07T19:00:00.000Z')
let db: Db
let log: Notification[]
let uploadsDir: string
let templateId: number
let employeeId: number

function submission(): number {
  const inst = createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: NOW.toISOString(), issued_at: NOW.toISOString(), due_at: NOW.toISOString(), status: 'submitted' })!
  const rel = join(String(inst.id), '1.jpg')
  mkdirSync(join(uploadsDir, String(inst.id)), { recursive: true })
  writeFileSync(join(uploadsDir, rel), 'jpeg')
  return createSubmission(db, inst.id, NOW.toISOString(), [{ path: rel, fileUniqueId: `u${inst.id}` }]).id
}

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  uploadsDir = mkdtempSync(join(tmpdir(), 'rq-'))
  employeeId = seed.employees.ivan.id
  templateId = createTaskTemplate(db, {
    title: 'Убрать стулья с улицы', description: '', requires_photo: true, photo_criteria: 'Стульев на улице нет',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60,
    position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null).id
})

const queueWith = (reviewer: (i: ReviewInput) => Promise<ReviewResult>, concurrency = 2) =>
  createReviewQueue({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir, reviewer, concurrency, now: () => NOW })

describe('review queue', () => {
  it('auto-accepts above the threshold and tells the employee', async () => {
    let seen: ReviewInput | undefined
    const q = queueWith(async (i) => { seen = i; return { score: 92, verdict: 'Всё убрано', issues: [] } })
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(seen?.photos).toHaveLength(1)
    expect(seen?.criteria).toBe('Стульев на улице нет')
    expect(getSubmission(db, id)).toMatchObject({ ai_status: 'done', ai_attempts: 1, ai_score: 92, decision: 'auto_accepted' })
    expect(getInstance(db, getSubmission(db, id)!.instance_id)?.status).toBe('accepted')
    expect(log).toEqual([{ to: 500, text: expect.stringContaining('92') }])
  })

  it('sends low scores to the owner with photos', async () => {
    const q = queueWith(async () => ({ score: 40, verdict: 'Два стула остались', issues: ['стулья у входа'] }))
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(getSubmission(db, id)?.decision).toBe('needs_review')
    expect(getInstance(db, getSubmission(db, id)!.instance_id)?.status).toBe('review')
    expect(log.find((n) => n.to === 500)?.text).toContain('владельцу')
    expect(log.find((n) => n.to === 'owner')?.text).toContain('стулья у входа')
  })

  it('marks failures and still routes to the owner', async () => {
    const q = queueWith(async () => { throw new Error('boom') })
    const id = submission()
    q.enqueue(id)
    await q.idle()
    expect(getSubmission(db, id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review', ai_attempts: 1 })
    expect(log.find((n) => n.to === 'owner')?.text).toContain('ИИ недоступен')
  })

  it('skips already decided submissions and limits concurrency', async () => {
    let running = 0
    let peak = 0
    const q = queueWith(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return { score: 90, verdict: 'ok', issues: [] }
    })
    const ids = [submission(), submission(), submission()]
    ids.forEach((id) => q.enqueue(id))
    await q.idle()
    expect(peak).toBe(2)
    const before = log.length
    q.enqueue(ids[0]!)
    await q.idle()
    expect(log.length).toBe(before)
    expect(getSubmission(db, ids[0]!)?.ai_attempts).toBe(1)
  })
})
```

Run: `npx vitest run server/tasks/reviewQueue.test.ts` → FAIL.

- [ ] **Step 6: server/tasks/reviewQueue.ts**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/connect.js'
import { getEmployee } from '../db/employees.js'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getTaskTemplate } from '../db/taskTemplates.js'
import { getReviewRow, getSubmission, listPhotos, markAiFailed, markAiStarted, saveAiResult } from '../db/taskSubmissions.js'
import type { Notifier } from '../notify.js'
import type { Reviewer } from '../ai/photoReview.js'
import { reviewKeyboard } from '../bot/keyboards.js'
import { decideByScore, ownerReviewCaption } from './decide.js'

export type ReviewQueue = { enqueue(submissionId: number): void; size(): number; idle(): Promise<void> }
export type ReviewQueueDeps = {
  db: Db
  notifier: Notifier
  tz: string
  uploadsDir: string
  reviewer: Reviewer
  concurrency?: number
  now?: () => Date
}

export function createReviewQueue(deps: ReviewQueueDeps): ReviewQueue {
  const { db, notifier, uploadsDir, reviewer } = deps
  const concurrency = deps.concurrency ?? 2
  const now = deps.now ?? (() => new Date())
  const waiting: number[] = []
  let running = 0
  let idleWaiters: (() => void)[] = []

  async function notifyEmployee(employeeId: number, text: string): Promise<void> {
    const e = getEmployee(db, employeeId)
    if (e?.telegram_id) await notifier.toEmployee(e.telegram_id, text)
  }

  async function process(submissionId: number): Promise<void> {
    const sub = getSubmission(db, submissionId)
    if (!sub || sub.decision !== null) return
    const row = getReviewRow(db, submissionId)
    const template = row ? getTaskTemplate(db, row.template_id) : null
    if (!row || !template) return
    markAiStarted(db, submissionId)
    const photos = listPhotos(db, submissionId).filter((p) => p.deleted_at === null)
    const paths = photos.map((p) => join(uploadsDir, p.path))
    try {
      const result = await reviewer({
        photos: paths.map((p) => ({ data: readFileSync(p), mediaType: 'image/jpeg' as const })),
        title: template.title,
        description: template.description,
        criteria: template.photo_criteria ?? '',
      })
      const decision = decideByScore(result.score, template.auto_accept_threshold)
      saveAiResult(db, submissionId, result, decision, now().toISOString())
      if (decision === 'auto_accepted') {
        setInstanceStatus(db, row.instance_id, 'accepted', { completed_at: now().toISOString() })
        await notifyEmployee(row.employee_id, `Принято, ${result.score} из 100. ${result.verdict}`.trim())
        return
      }
      setInstanceStatus(db, row.instance_id, 'review')
    } catch (err) {
      console.error('photo review failed', submissionId, err)
      markAiFailed(db, submissionId, now().toISOString())
      setInstanceStatus(db, row.instance_id, 'review')
    }
    await notifyEmployee(row.employee_id, 'Отправил владельцу на проверку.')
    const fresh = getReviewRow(db, submissionId)!
    await notifier.photosToOwner(paths, ownerReviewCaption(fresh), reviewKeyboard(submissionId))
  }

  function pump(): void {
    while (running < concurrency && waiting.length > 0) {
      const id = waiting.shift()!
      running++
      process(id)
        .catch((err) => console.error('review job crashed', id, err))
        .finally(() => {
          running--
          if (running === 0 && waiting.length === 0) {
            const w = idleWaiters
            idleWaiters = []
            w.forEach((fn) => fn())
          } else {
            pump()
          }
        })
    }
  }

  return {
    enqueue(submissionId) {
      if (waiting.includes(submissionId)) return
      waiting.push(submissionId)
      pump()
    },
    size: () => waiting.length + running,
    idle: () =>
      running === 0 && waiting.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve)),
  }
}
```

Run: `npx vitest run server/tasks/reviewQueue.test.ts` → 4 passed.

- [ ] **Step 7: Зелёные, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/ai server/tasks/decide.ts server/tasks/decide.test.ts server/tasks/reviewQueue.ts server/tasks/reviewQueue.test.ts
git commit -m "feat: Claude photo review, decisions and background review queue

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Решение владельца: бот и API очереди

**Files:**
- Create: `server/bot/review.ts`, `server/bot/review.test.ts`
- Modify: `server/bot/createBot.ts` (регистрация `registerReview` после `registerTasks`), `server/bot/roles.ts` (сводка), `server/bot/linking.ts` (передача `now`), `server/db/taskInstances.ts` (`countOverdueSince`), `server/api/tasks.ts`, `server/api/tasks.test.ts`

**Interfaces:**
- Consumes: `applyOwnerDecision`, `listReviewQueue`, `getReviewRow`, `CB_RE.accept/reject`, `cancelKeyboard`, `ownerMenu`, `getState/setState/clearState`.
- Produces `registerReview(bot, deps)`; состояние владельца `{ kind: 'reject_comment'; submission_id: number }`.
- Produces `countOverdueSince(db, sinceIso): number`; `summaryText(db, publicUrl, now: Date)` дополняется строками `На проверке: N` и `Просрочено за сутки: M`.
- Produces HTTP: `GET /api/tasks/review-queue` → `ReviewRow[]`; `POST /api/tasks/submissions/:id/decide` `{ decision: 'accept' | 'reject'; comment?: string }` → 200 `{ ok: true }`; 400 validation (reject без непустого comment); 404 `not_found`; 409 `already_decided`.
- Тексты: «Только для владельца.», «Уже решено.», «Принято: <название>», «Напишите комментарий для сотрудника.», «Отклонено, сотруднику отправлено.», «Отменено.».

- [ ] **Step 1: Тест бота владельца**

`server/bot/review.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { callbackUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'

const NOW = '2026-09-07T19:00:00.000Z'
let db: Db
let bot: Bot
let calls: ApiCall[]
let subId: number
let instId: number

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => ({ to: c.payload.chat_id, text: String(c.payload.text) }))
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  ;({ bot, calls } = makeBot(db))
  const t = createTaskTemplate(db, {
    title: 'Помыть кофемашину', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  instId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'review' })!.id
  subId = createSubmission(db, instId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }]).id
  saveAiResult(db, subId, { score: 50, verdict: 'Поддон грязный', issues: ['поддон'] }, 'needs_review', NOW)
})

describe('owner review in bot', () => {
  it('only the owner can decide', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.accept(subId)))
    expect(lastAnswer()).toBe('Только для владельца.')
    expect(getSubmission(db, subId)?.decision).toBe('needs_review')
  })

  it('accept closes the task and notifies the employee', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.accept(subId)))
    expect(getSubmission(db, subId)?.decision).toBe('owner_accepted')
    expect(getInstance(db, instId)?.status).toBe('accepted')
    expect(texts().some((t) => t.to === 500 && /принято/i.test(t.text))).toBe(true)
    expect(texts().some((t) => t.to === 42 && t.text.startsWith('Принято: Помыть кофемашину'))).toBe(true)
    await bot.handleUpdate(callbackUpdate(42, CB.accept(subId)))
    expect(lastAnswer()).toBe('Уже решено.')
  })

  it('reject asks for a comment, then reopens the task with it', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.reject(subId)))
    expect(texts().at(-1)?.text).toBe('Напишите комментарий для сотрудника.')
    expect(getState<{ kind: string }>(db, 42)?.kind).toBe('reject_comment')
    await bot.handleUpdate(textUpdate(42, 'Поддон нужно вымыть'))
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_rejected', owner_comment: 'Поддон нужно вымыть' })
    expect(getInstance(db, instId)?.status).toBe('pending')
    expect(texts().some((t) => t.to === 500 && t.text.includes('Поддон нужно вымыть'))).toBe(true)
    expect(texts().at(-1)?.text).toBe('Отклонено, сотруднику отправлено.')
    expect(getState(db, 42)).toBeNull()
  })

  it('cancel leaves the comment mode without deciding', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.reject(subId)))
    await bot.handleUpdate(textUpdate(42, 'Отмена'))
    expect(texts().at(-1)?.text).toBe('Отменено.')
    expect(getState(db, 42)).toBeNull()
    expect(getSubmission(db, subId)?.decision).toBe('needs_review')
  })

  it('summary shows the review queue and overdue counters', async () => {
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(texts().at(-1)?.text).toContain('На проверке: 1')
    expect(texts().at(-1)?.text).toContain('Просрочено за сутки: 0')
  })
})
```

Run: `npx vitest run server/bot/review.test.ts` → FAIL.

- [ ] **Step 2: countOverdueSince и сводка**

`server/db/taskInstances.ts`, добавить:
```ts
export function countOverdueSince(db: Db, sinceIso: string): number {
  return (db.prepare("select count(*) c from task_instances where status = 'overdue' and due_at >= ?").get(sinceIso) as { c: number }).c
}
```

`server/bot/roles.ts`, новая сигнатура `summaryText(db, publicUrl: string | undefined, now: Date)`:
```ts
import { countOverdueSince } from '../db/taskInstances.js'
import { listReviewQueue } from '../db/taskSubmissions.js'

export function summaryText(db: Db, publicUrl: string | undefined, now: Date): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  const lines = [
    `Активны: ${active}`,
    `Приглашены: ${invited}`,
    `На проверке: ${listReviewQueue(db).length}`,
    `Просрочено за сутки: ${countOverdueSince(db, dayAgo)}`,
  ]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
```
В `server/bot/linking.ts` все вызовы `summaryText(db, deps.publicUrl)` заменить на `summaryText(db, deps.publicUrl, deps.now())`. Тест сводки в `createBot.test.ts` (ищет `Приглашены: 1` и ссылку) остаётся зелёным.

- [ ] **Step 3: server/bot/review.ts**

```ts
import type { Bot, Context } from 'grammy'
import { clearState, getState, setState } from '../db/botStates.js'
import { getReviewRow } from '../db/taskSubmissions.js'
import { applyOwnerDecision } from '../tasks/decide.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { BTN, cancelKeyboard, ownerMenu } from './keyboards.js'
import { roleOf } from './roles.js'

type RejectState = { kind: 'reject_comment'; submission_id: number }

export function registerReview(bot: Bot, deps: BotDeps): void {
  const { db } = deps
  const isOwner = (ctx: Context) => !!ctx.from && roleOf(db, ctx.from.id).kind === 'owner'
  const rejectState = (telegramId: number): RejectState | null => {
    const s = getState<RejectState>(db, telegramId)
    return s?.kind === 'reject_comment' ? s : null
  }
  const decisionDeps = { db, notifier: deps.notifier, tz: deps.tz }

  async function dropButtons(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } catch {
      /* сообщение могло быть альбомом или уже изменено */
    }
  }

  bot.callbackQuery(CB_RE.accept, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    const r = await applyOwnerDecision(decisionDeps, id, 'accept', null, deps.now())
    if (!r.ok) return ctx.answerCallbackQuery({ text: r.reason === 'not_found' ? 'Сдача не найдена.' : 'Уже решено.' })
    await ctx.answerCallbackQuery({ text: 'Принято' })
    await dropButtons(ctx)
    await ctx.reply(`Принято: ${row?.title ?? ''}`.trim(), { reply_markup: ownerMenu() })
  })

  bot.callbackQuery(CB_RE.reject, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    if (!row || row.decision !== 'needs_review') return ctx.answerCallbackQuery({ text: 'Уже решено.' })
    setState(db, ctx.from.id, { kind: 'reject_comment', submission_id: id } satisfies RejectState)
    await ctx.answerCallbackQuery()
    await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
  })

  bot.hears(BTN.cancel, async (ctx, next) => {
    if (!ctx.from || !rejectState(ctx.from.id)) return next()
    clearState(db, ctx.from.id)
    await ctx.reply('Отменено.', { reply_markup: ownerMenu() })
  })

  bot.on('message:text', async (ctx, next) => {
    const state = rejectState(ctx.from.id)
    if (!state || !isOwner(ctx)) return next()
    const comment = ctx.message.text.trim()
    if (!comment) return
    const r = await applyOwnerDecision(decisionDeps, state.submission_id, 'reject', comment, deps.now())
    clearState(db, ctx.from.id)
    await ctx.reply(r.ok ? 'Отклонено, сотруднику отправлено.' : 'Уже решено.', { reply_markup: ownerMenu() })
  })
}
```

`server/bot/createBot.ts`: после `registerTasks(bot, deps)` добавить `registerReview(bot, deps)`, затем `registerFallback`.

Run: `npx vitest run server/bot` → все passed.

- [ ] **Step 4: API очереди и решения**

Добавить в `server/api/tasks.test.ts`:
```ts
import { createInstance } from '../db/taskInstances.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'

describe('review queue api', () => {
  it('lists the queue and applies decisions once', async () => {
    const { app, seed, h, db, notifications } = await setup()
    const create = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    const templateId = create.json().template.id
    const inst = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T19:00:00.000Z', issued_at: '2026-09-07T19:00:00.000Z', due_at: '2026-09-07T20:00:00.000Z', status: 'review' })!
    const sub = createSubmission(db, inst.id, '2026-09-07T19:10:00.000Z', [{ path: '1/a.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, sub.id, { score: 45, verdict: 'Грязно', issues: ['поддон'] }, 'needs_review', '2026-09-07T19:11:00.000Z')

    const queue = await app.inject({ method: 'GET', url: '/api/tasks/review-queue', headers: h })
    expect(queue.json()).toHaveLength(1)
    expect(queue.json()[0]).toMatchObject({ id: sub.id, title: 'Помыть кофемашину', employee_name: 'Иван Петров', ai_score: 45 })
    expect(queue.json()[0].photos[0].path).toBe('1/a.jpg')

    const bad = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'reject' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'reject', comment: 'Поддон' } })
    expect(ok.statusCode).toBe(200)
    expect(notifications.some((n) => n.to === 500 && n.text.includes('Поддон'))).toBe(true)
    const again = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'accept' } })
    expect(again.statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/tasks/submissions/999/decide', headers: h, payload: { decision: 'accept' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/tasks/review-queue', headers: h })).json()).toEqual([])
  })
})
```

В `server/api/tasks.ts` добавить импорты `listReviewQueue` (из `../db/taskSubmissions.js`) и `applyOwnerDecision` (из `../tasks/decide.js`), схему и роуты:
```ts
const decideBody = z
  .object({ decision: z.enum(['accept', 'reject']), comment: z.string().trim().max(1000).optional() })
  .superRefine((b, ctx) => {
    if (b.decision === 'reject' && !b.comment) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Напишите комментарий' })
  })

  app.get('/api/tasks/review-queue', async () => listReviewQueue(db))

  app.post('/api/tasks/submissions/:id/decide', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const body = parse(decideBody, req.body)
    const r = await applyOwnerDecision({ db, notifier, tz }, id, body.decision, body.comment ?? null, now())
    if (!r.ok) return reply.code(r.reason === 'not_found' ? 404 : 409).send({ error: r.reason })
    return { ok: true }
  })
```

Run: `npx vitest run server/api/tasks.test.ts` → 7 passed.

- [ ] **Step 5: Зелёные, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add -A
git commit -m "feat: owner decisions in bot and review queue API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Планировщик

**Files:**
- Create: `server/scheduler/tick.ts`, `server/scheduler/issueDue.ts`, `server/scheduler/reminders.ts`, `server/scheduler/overdue.ts`, `server/scheduler/retryReviews.ts`, `server/scheduler/cleanup.ts`, `server/db/maintenance.ts`, `server/scheduler/tick.test.ts`
- Modify: `server/tasks/reviewQueue.ts` (не ставить в очередь то, что уже выполняется), `server/tasks/reviewQueue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type SchedulerDeps = { db: Db; notifier: Notifier; tz: string; uploadsDir: string; reviewQueue: Pick<ReviewQueue, 'enqueue'>; now?: () => Date }
  type Scheduler = { tick(): Promise<void>; start(intervalMs?: number): () => void }   // start возвращает stop
  createScheduler(deps: SchedulerDeps): Scheduler
  issueDueTemplates(deps, now: Date): Promise<number>        // число выданных экземпляров
  sendReminders(deps, now: Date): Promise<number>
  markOverdue(deps, now: Date): Promise<number>
  retryStaleReviews(deps, now: Date): Promise<{ retried: number; failed: number }>
  cleanup(deps, now: Date): Promise<{ photos: number; sessions: number; codes: number }>
  purgeAuth(db, nowMs: number): { sessions: number; codes: number }   // server/db/maintenance.ts
  ```
- Константы: `MISSED_SLOT_GRACE_MS = 60 * 60_000`, `STALE_REVIEW_MS = 3 * 60_000`, `MAX_AI_ATTEMPTS = 3`, `DEFAULT_RETENTION_DAYS = 90`, `CLEANUP_INTERVAL_MS = 60 * 60_000`.
- `ReviewQueue.enqueue` игнорирует id, который сейчас обрабатывается.

- [ ] **Step 1: Защита очереди от повторного запуска активной сдачи**

В `server/tasks/reviewQueue.ts`: завести `const active = new Set<number>()`; в `pump` перед запуском `active.add(id)`, в `finally` `active.delete(id)`; в `enqueue`: `if (waiting.includes(submissionId) || active.has(submissionId)) return`.

Тест в `server/tasks/reviewQueue.test.ts`:
```ts
  it('ignores enqueue for a submission that is being processed', async () => {
    let calls = 0
    const q = queueWith(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { score: 90, verdict: 'ok', issues: [] } })
    const id = submission()
    q.enqueue(id)
    await new Promise((r) => setTimeout(r, 5))
    q.enqueue(id)
    await q.idle()
    expect(calls).toBe(1)
  })
```
Run: `npx vitest run server/tasks/reviewQueue.test.ts` → 5 passed.

- [ ] **Step 2: Тест планировщика**

`server/scheduler/tick.test.ts`:
```ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, getInstance, listInstances } from '../db/taskInstances.js'
import { createTaskTemplate, getTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, markAiStarted } from '../db/taskSubmissions.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { createScheduler, type SchedulerDeps } from './tick.js'
import { issueDueTemplates } from './issueDue.js'
import { sendReminders } from './reminders.js'
import { markOverdue } from './overdue.js'
import { retryStaleReviews } from './retryReviews.js'
import { cleanup } from './cleanup.js'

let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
let enqueued: number[]
let deps: SchedulerDeps
const T = (iso: string) => new Date(iso)

const tpl = (over: Partial<TaskTemplateInput> = {}): TaskTemplateInput => ({
  title: 'Помыть кофемашину', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
  assignee_mode: 'by_position', distribution: 'each', schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [], ...over,
})

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  enqueued = []
  deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir: mkdtempSync(join(tmpdir(), 'sch-')), reviewQueue: { enqueue: (id) => enqueued.push(id) } }
})

describe('issueDueTemplates', () => {
  it('issues a due slot and advances next_run_at', async () => {
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T19:00:30.000Z'))).toBe(2)
    expect(listInstances(db, {}).every((i) => i.slot_at === '2026-09-07T19:00:00.000Z' && i.due_at === '2026-09-07T20:00:00.000Z')).toBe(true)
    expect(getTaskTemplate(db, t.id)?.next_run_at).toBe('2026-09-08T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T19:01:30.000Z'))).toBe(0)
  })

  it('skips a slot missed by more than an hour', async () => {
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    expect(await issueDueTemplates(deps, T('2026-09-07T20:30:00.000Z'))).toBe(0)
    expect(listInstances(db, {})).toEqual([])
    expect(getTaskTemplate(db, t.id)?.next_run_at).toBe('2026-09-08T19:00:00.000Z')
  })

  it('ignores one-off templates', async () => {
    createTaskTemplate(db, tpl({ schedule: null }), null)
    expect(await issueDueTemplates(deps, T('2026-09-07T19:00:30.000Z'))).toBe(0)
  })
})

describe('reminders', () => {
  it('reminds once, 2h before for long tasks and at half time for short ones', async () => {
    const long = createTaskTemplate(db, tpl({ deadline_minutes: 480 }), null)
    const short = createTaskTemplate(db, tpl({ deadline_minutes: 60 }), null)
    createInstance(db, { template_id: long.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T18:00:00.000Z', status: 'pending' })
    createInstance(db, { template_id: short.id, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T15:30:00.000Z', issued_at: '2026-09-07T15:30:00.000Z', due_at: '2026-09-07T16:30:00.000Z', status: 'pending' })
    expect(await sendReminders(deps, T('2026-09-07T15:50:00.000Z'))).toBe(0)
    expect(await sendReminders(deps, T('2026-09-07T16:01:00.000Z'))).toBe(2)
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toMatch(/Напоминание/)
    expect(await sendReminders(deps, T('2026-09-07T16:05:00.000Z'))).toBe(0)
  })
})

describe('overdue', () => {
  it('marks pending and open instances and notifies', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const p = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'pending' })!
    const o = createInstance(db, { template_id: t.id, employee_id: null, slot_at: '2026-09-07T09:00:00.000Z', issued_at: '2026-09-07T09:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'open' })!
    expect(await markOverdue(deps, T('2026-09-07T11:01:00.000Z'))).toBe(2)
    expect(getInstance(db, p.id)?.status).toBe('overdue')
    expect(getInstance(db, o.id)?.status).toBe('overdue')
    expect(log.filter((n) => n.to === 500)).toHaveLength(1)
    expect(log.filter((n) => n.to === 'owner').map((n) => n.text).join(' ')).toMatch(/Никто не взял/)
    expect(await markOverdue(deps, T('2026-09-07T11:02:00.000Z'))).toBe(0)
  })
})

describe('retryStaleReviews', () => {
  it('re-enqueues stale pending reviews and fails after 3 attempts', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const i1 = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'submitted' })!
    const i2 = createInstance(db, { template_id: t.id, employee_id: seed.employees.anna.id, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'submitted' })!
    const fresh = createSubmission(db, i1.id, '2026-09-07T10:59:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    const stale = createSubmission(db, i2.id, '2026-09-07T10:50:00.000Z', [{ path: 'b.jpg', fileUniqueId: 'u2' }])
    expect(await retryStaleReviews(deps, T('2026-09-07T11:00:00.000Z'))).toEqual({ retried: 1, failed: 0 })
    expect(enqueued).toEqual([stale.id])
    expect(getSubmission(db, fresh.id)?.ai_status).toBe('pending')
    markAiStarted(db, stale.id)
    markAiStarted(db, stale.id)
    markAiStarted(db, stale.id)
    // к 11:10 свежая сдача тоже устарела и уходит на повтор, а исчерпавшая попытки помечается failed
    expect(await retryStaleReviews(deps, T('2026-09-07T11:10:00.000Z'))).toEqual({ retried: 1, failed: 1 })
    expect(enqueued).toEqual([stale.id, fresh.id])
    expect(getSubmission(db, stale.id)).toMatchObject({ ai_status: 'failed', decision: 'needs_review' })
    expect(getInstance(db, i2.id)?.status).toBe('review')
    expect(log.some((n) => n.to === 'owner' && n.text.includes('ИИ недоступен'))).toBe(true)
  })
})

describe('cleanup', () => {
  it('deletes old photo files, keeps rows, purges expired sessions and used codes', async () => {
    const t = createTaskTemplate(db, tpl(), null)
    const i = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: '2026-05-01T10:00:00.000Z', issued_at: '2026-05-01T10:00:00.000Z', due_at: '2026-05-01T11:00:00.000Z', status: 'accepted' })!
    mkdirSync(join(deps.uploadsDir, String(i.id)), { recursive: true })
    const rel = join(String(i.id), 'old.jpg')
    writeFileSync(join(deps.uploadsDir, rel), 'x')
    const s = createSubmission(db, i.id, '2026-05-01T10:30:00.000Z', [{ path: rel, fileUniqueId: 'u1' }])
    let clock = Date.parse('2026-09-07T10:00:00.000Z')
    const auth = createOwnerAuth(db, () => clock)
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    clock += 31 * 24 * 60 * 60_000
    const r = await cleanup(deps, new Date(clock))
    expect(r).toEqual({ photos: 1, sessions: 1, codes: 1 })
    expect(existsSync(join(deps.uploadsDir, rel))).toBe(false)
    expect(getSubmission(db, s.id)).not.toBeNull()
    expect(auth.hasSession(token)).toBe(false)
  })
})

describe('tick', () => {
  it('runs the remaining steps even when an earlier step throws', async () => {
    // выдача упадёт на первом же уведомлении сотруднику, просрочка общего задания всё равно должна отработать
    const t = createTaskTemplate(db, tpl(), '2026-09-07T19:00:00.000Z')
    const o = createInstance(db, { template_id: t.id, employee_id: null, slot_at: '2026-09-07T10:00:00.000Z', issued_at: '2026-09-07T10:00:00.000Z', due_at: '2026-09-07T11:00:00.000Z', status: 'open' })!
    const throwing = { ...fakeNotifier(log), toEmployee: async () => { throw new Error('telegram down') } }
    const s = createScheduler({ ...deps, notifier: throwing, now: () => T('2026-09-07T19:00:30.000Z') })
    await s.tick()
    expect(getInstance(db, o.id)?.status).toBe('overdue')
    expect(log.some((n) => n.to === 'owner' && /Никто не взял/.test(n.text))).toBe(true)
  })
})
```

Run: `npx vitest run server/scheduler` → FAIL (модули не найдены).

- [ ] **Step 3: Шаги планировщика**

`server/db/maintenance.ts`:
```ts
import type { Db } from './connect.js'

export function purgeAuth(db: Db, nowMs: number): { sessions: number; codes: number } {
  const sessions = db.prepare('delete from owner_sessions where expires_at <= ?').run(nowMs).changes
  const codes = db.prepare('delete from owner_login_codes where used = 1 or expires_at <= ?').run(nowMs).changes
  return { sessions, codes }
}
```

`server/scheduler/issueDue.ts`:
```ts
import { listDueTemplates, setNextRunAt } from '../db/taskTemplates.js'
import { issueTemplate } from '../tasks/issue.js'
import { nextRun } from '../tasks/schedule.js'
import type { SchedulerDeps } from './tick.js'

export const MISSED_SLOT_GRACE_MS = 60 * 60_000

export async function issueDueTemplates(deps: SchedulerDeps, now: Date): Promise<number> {
  let issued = 0
  for (const t of listDueTemplates(deps.db, now.toISOString())) {
    if (!t.schedule || !t.next_run_at) continue
    const slot = new Date(t.next_run_at)
    if (now.getTime() - slot.getTime() > MISSED_SLOT_GRACE_MS) {
      console.warn(`scheduler: skipping missed slot ${t.next_run_at} for template ${t.id}`)
    } else {
      const r = await issueTemplate({ db: deps.db, notifier: deps.notifier, tz: deps.tz }, t, slot, now)
      issued += r.created.length
    }
    const from = new Date(Math.max(slot.getTime(), now.getTime() - MISSED_SLOT_GRACE_MS))
    setNextRunAt(deps.db, t.id, nextRun(t.schedule, from, deps.tz).toISOString())
  }
  return issued
}
```

`server/scheduler/reminders.ts`:
```ts
import { getEmployee } from '../db/employees.js'
import { getInstanceRow, listReminderCandidates, markReminderSent } from '../db/taskInstances.js'
import { taskDueText } from '../tasks/issue.js'
import { openTaskKeyboard } from '../bot/keyboards.js'
import type { SchedulerDeps } from './tick.js'

const TWO_HOURS = 2 * 60 * 60_000
const FOUR_HOURS = 4 * 60 * 60_000

export function reminderLeadMs(durationMs: number): number {
  return durationMs > FOUR_HOURS ? TWO_HOURS : Math.floor(durationMs / 2)
}

export async function sendReminders(deps: SchedulerDeps, now: Date): Promise<number> {
  let sent = 0
  for (const inst of listReminderCandidates(deps.db, now.toISOString())) {
    const due = new Date(inst.due_at)
    const duration = due.getTime() - new Date(inst.issued_at).getTime()
    if (due.getTime() - now.getTime() > reminderLeadMs(duration)) continue
    markReminderSent(deps.db, inst.id, now.toISOString())
    const row = getInstanceRow(deps.db, inst.id)
    const employee = inst.employee_id ? getEmployee(deps.db, inst.employee_id) : null
    if (!row || !employee?.telegram_id) continue
    const id = await deps.notifier.toEmployee(employee.telegram_id, `Напоминание: «${row.title}»\n${taskDueText(due, deps.tz, now)}`, {
      keyboard: openTaskKeyboard(inst.id),
    })
    if (id !== null) sent++
  }
  return sent
}
```

`server/scheduler/overdue.ts`:
```ts
import { getEmployee } from '../db/employees.js'
import { getInstanceRow, listOverdueCandidates, setInstanceStatus } from '../db/taskInstances.js'
import type { SchedulerDeps } from './tick.js'

export async function markOverdue(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const inst of listOverdueCandidates(deps.db, now.toISOString())) {
    setInstanceStatus(deps.db, inst.id, 'overdue')
    count++
    const row = getInstanceRow(deps.db, inst.id)
    if (!row) continue
    if (inst.status === 'open') {
      await deps.notifier.toOwner(`Никто не взял задание «${row.title}», срок истёк.`)
      continue
    }
    const employee = inst.employee_id ? getEmployee(deps.db, inst.employee_id) : null
    if (employee?.telegram_id) {
      await deps.notifier.toEmployee(employee.telegram_id, `Просрочено: «${row.title}». Выполните и сообщите владельцу.`)
    }
    await deps.notifier.toOwner(`Просрочено: «${row.title}», ${row.employee_name ?? 'без исполнителя'}.`)
  }
  return count
}
```

`server/scheduler/retryReviews.ts`:
```ts
import { join } from 'node:path'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getReviewRow, listPhotos, listStaleAiPending, markAiFailed } from '../db/taskSubmissions.js'
import { ownerReviewCaption } from '../tasks/decide.js'
import { reviewKeyboard } from '../bot/keyboards.js'
import type { SchedulerDeps } from './tick.js'

export const STALE_REVIEW_MS = 3 * 60_000
export const MAX_AI_ATTEMPTS = 3

export async function retryStaleReviews(deps: SchedulerDeps, now: Date): Promise<{ retried: number; failed: number }> {
  let retried = 0
  let failed = 0
  const before = new Date(now.getTime() - STALE_REVIEW_MS).toISOString()
  for (const s of listStaleAiPending(deps.db, before)) {
    if (s.ai_attempts < MAX_AI_ATTEMPTS) {
      deps.reviewQueue.enqueue(s.id)
      retried++
      continue
    }
    markAiFailed(deps.db, s.id, now.toISOString())
    setInstanceStatus(deps.db, s.instance_id, 'review')
    failed++
    const row = getReviewRow(deps.db, s.id)
    if (!row) continue
    const paths = listPhotos(deps.db, s.id).filter((p) => !p.deleted_at).map((p) => join(deps.uploadsDir, p.path))
    await deps.notifier.photosToOwner(paths, ownerReviewCaption(row), reviewKeyboard(s.id))
  }
  return { retried, failed }
}
```

`server/scheduler/cleanup.ts`:
```ts
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { purgeAuth } from '../db/maintenance.js'
import { getSetting } from '../db/settings.js'
import { listPhotosOlderThan, markPhotoDeleted } from '../db/taskSubmissions.js'
import type { SchedulerDeps } from './tick.js'

export const DEFAULT_RETENTION_DAYS = 90
export const PHOTO_RETENTION_KEY = 'photo_retention_days'

export async function cleanup(deps: SchedulerDeps, now: Date): Promise<{ photos: number; sessions: number; codes: number }> {
  const days = Number(getSetting(deps.db, PHOTO_RETENTION_KEY) ?? DEFAULT_RETENTION_DAYS)
  const before = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString()
  let photos = 0
  for (const p of listPhotosOlderThan(deps.db, before)) {
    rmSync(join(deps.uploadsDir, p.path), { force: true })
    markPhotoDeleted(deps.db, p.id, now.toISOString())
    photos++
  }
  const auth = purgeAuth(deps.db, now.getTime())
  return { photos, ...auth }
}
```

`server/scheduler/tick.ts`:
```ts
import type { Db } from '../db/connect.js'
import type { Notifier } from '../notify.js'
import type { ReviewQueue } from '../tasks/reviewQueue.js'
import { cleanup } from './cleanup.js'
import { issueDueTemplates } from './issueDue.js'
import { markOverdue } from './overdue.js'
import { sendReminders } from './reminders.js'
import { retryStaleReviews } from './retryReviews.js'

export type SchedulerDeps = {
  db: Db
  notifier: Notifier
  tz: string
  uploadsDir: string
  reviewQueue: Pick<ReviewQueue, 'enqueue'>
  now?: () => Date
}
export type Scheduler = { tick(): Promise<void>; start(intervalMs?: number): () => void }

export const CLEANUP_INTERVAL_MS = 60 * 60_000

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date())
  let running = false
  let lastCleanup = 0

  async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      console.error(`scheduler step ${name} failed`, err)
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const t = now()
      await step('issue', () => issueDueTemplates(deps, t))
      await step('reminders', () => sendReminders(deps, t))
      await step('overdue', () => markOverdue(deps, t))
      await step('retryReviews', () => retryStaleReviews(deps, t))
      if (t.getTime() - lastCleanup >= CLEANUP_INTERVAL_MS) {
        lastCleanup = t.getTime()
        await step('cleanup', () => cleanup(deps, t))
      }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start(intervalMs = 60_000) {
      const first = setTimeout(() => void tick(), 5_000)
      const timer = setInterval(() => void tick(), intervalMs)
      return () => {
        clearTimeout(first)
        clearInterval(timer)
      }
    },
  }
}
```

Run: `npx vitest run server/scheduler` → 8 passed.

- [ ] **Step 4: Зелёные, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/scheduler server/db/maintenance.ts server/tasks/reviewQueue.ts server/tasks/reviewQueue.test.ts
git commit -m "feat: scheduler tick with issuing, reminders, overdue, review retries and cleanup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Админка: шаблоны, журнал, проверка фото

**Files:**
- Modify: `admin/src/api.ts`, `admin/src/router.ts`, `admin/src/components/AppLayout.vue`
- Create: `admin/src/lib/schedule.ts`, `admin/src/reviewCount.ts`, `admin/src/pages/TemplatesPage.vue`, `admin/src/pages/TemplateForm.vue`, `admin/src/pages/InstancesPage.vue`, `admin/src/pages/ReviewPage.vue`

**Interfaces:**
- Consumes HTTP из Task 5 и Task 8.
- Produces маршруты: `/tasks` (шаблоны), `/tasks/new`, `/tasks/:id/edit`, `/journal`, `/review`; меню: Задания, Журнал, Проверка фото (со счётчиком), Сотрудники, Должности. Стартовый редирект `/` → `/tasks`.
- Юнит-тестов на Vue по-прежнему нет; проверка сборкой и ручным прогоном в Task 11.

- [ ] **Step 1: admin/src/api.ts, типы и методы**

Добавить после существующих типов:
```ts
export type Schedule =
  | { kind: 'weekly'; days: number[]; times: string[] }
  | { kind: 'interval'; days: number[]; from: string; to: string; every_minutes: number }

export type TaskTemplate = {
  id: number
  title: string
  description: string
  requires_photo: boolean
  photo_criteria: string | null
  auto_accept_threshold: number
  assignee_mode: 'by_position' | 'by_employees'
  distribution: 'each' | 'shared'
  schedule: Schedule | null
  deadline_minutes: number
  next_run_at: string | null
  active: boolean
  created_at: string
  position_ids: number[]
  employee_ids: number[]
}
export type TaskTemplateInput = Omit<TaskTemplate, 'id' | 'next_run_at' | 'active' | 'created_at'>

export type InstanceStatus = 'open' | 'pending' | 'submitted' | 'review' | 'accepted' | 'overdue'
export type InstanceRow = {
  id: number
  template_id: number
  employee_id: number | null
  slot_at: string
  issued_at: string
  due_at: string
  claimed_at: string | null
  status: InstanceStatus
  completed_at: string | null
  title: string
  requires_photo: boolean
  employee_name: string | null
  last_score: number | null
}
export type Photo = { id: number; position: number; path: string; deleted_at: string | null }
export type Submission = {
  id: number
  created_at: string
  ai_status: 'pending' | 'done' | 'failed'
  ai_score: number | null
  ai_verdict: string | null
  ai_issues: string[]
  decision: 'auto_accepted' | 'needs_review' | 'owner_accepted' | 'owner_rejected' | null
  owner_comment: string | null
  decided_at: string | null
  photos: Photo[]
}
export type ReviewRow = Submission & { instance_id: number; title: string; photo_criteria: string | null; employee_name: string }
export type InstanceFilters = { status?: InstanceStatus; employee_id?: number; template_id?: number }

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : ''
}
```
и в объект `api`:
```ts
  tasks: {
    templates: {
      list: (includeInactive = true) => request<TaskTemplate[]>('GET', `/api/tasks/templates${includeInactive ? '?includeInactive=1' : ''}`),
      get: (id: number) => request<TaskTemplate>('GET', `/api/tasks/templates/${id}`),
      create: (input: TaskTemplateInput) =>
        request<{ template: TaskTemplate; issued: { created: number; notified: number } | null }>('POST', '/api/tasks/templates', input),
      update: (id: number, input: TaskTemplateInput) => request<TaskTemplate>('PATCH', `/api/tasks/templates/${id}`, input),
      activate: (id: number) => request<TaskTemplate>('POST', `/api/tasks/templates/${id}/activate`),
      deactivate: (id: number) => request<TaskTemplate>('POST', `/api/tasks/templates/${id}/deactivate`),
    },
    instances: {
      list: (f: InstanceFilters) => request<InstanceRow[]>('GET', `/api/tasks/instances${qs(f)}`),
      get: (id: number) => request<{ instance: InstanceRow; submissions: Submission[] }>('GET', `/api/tasks/instances/${id}`),
    },
    reviewQueue: () => request<ReviewRow[]>('GET', '/api/tasks/review-queue'),
    decide: (id: number, decision: 'accept' | 'reject', comment?: string) =>
      request<{ ok: true }>('POST', `/api/tasks/submissions/${id}/decide`, { decision, comment }),
  },
```
В `errorText` добавить разбор zod-issues: если `err.body` содержит `issues` (массив с `message`), вернуть `map.validation ?? issues.map(i => i.message).join('. ')`. Тип `body` расширить до `{ error?: string; issues?: { message: string }[] } | null`.

- [ ] **Step 2: admin/src/lib/schedule.ts и admin/src/reviewCount.ts**

`admin/src/lib/schedule.ts`:
```ts
import type { InstanceStatus, Schedule } from '../api'

export const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

function daysText(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return 'Ежедневно'
  if (sorted.join() === '1,2,3,4,5') return 'По будням'
  return sorted.map((d) => DAY_LABELS[d - 1]).join(', ')
}

export function describeSchedule(s: Schedule | null): string {
  if (!s) return 'Разовое'
  if (s.kind === 'weekly') return `${daysText(s.days)} в ${[...s.times].sort().join(', ')}`
  const h = s.every_minutes % 60 === 0 ? `${s.every_minutes / 60} ч` : `${s.every_minutes} мин`
  return `${daysText(s.days)} каждые ${h} с ${s.from} до ${s.to}`
}

export const STATUS_LABEL: Record<InstanceStatus, string> = {
  open: 'Никто не взял',
  pending: 'Выполняется',
  submitted: 'Проверяет ИИ',
  review: 'На проверке',
  accepted: 'Принято',
  overdue: 'Просрочено',
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
```

`admin/src/reviewCount.ts`:
```ts
import { ref } from 'vue'
import { api } from './api'

export const reviewCount = ref(0)

export async function refreshReviewCount(): Promise<void> {
  try {
    reviewCount.value = (await api.tasks.reviewQueue()).length
  } catch {
    /* счётчик не критичен */
  }
}
```

- [ ] **Step 3: Роутер и шапка**

`admin/src/router.ts`: импортировать новые страницы и заменить `children`:
```ts
      children: [
        { path: '', redirect: '/tasks' },
        { path: 'tasks', component: TemplatesPage },
        { path: 'tasks/new', component: TemplateForm },
        { path: 'tasks/:id/edit', component: TemplateForm, props: true },
        { path: 'journal', component: InstancesPage },
        { path: 'review', component: ReviewPage },
        { path: 'employees', component: EmployeesPage },
        { path: 'positions', component: PositionsPage },
      ],
```

`admin/src/components/AppLayout.vue`: в `<script setup>` добавить
```ts
import { onMounted, onUnmounted } from 'vue'
import { refreshReviewCount, reviewCount } from '../reviewCount'
let timer: number | undefined
onMounted(() => {
  void refreshReviewCount()
  timer = window.setInterval(() => void refreshReviewCount(), 60_000)
})
onUnmounted(() => window.clearInterval(timer))
```
и в `<nav>` перед «Сотрудники» вставить:
```vue
        <RouterLink to="/tasks" class="text-sm hover:underline" active-class="font-semibold">Задания</RouterLink>
        <RouterLink to="/journal" class="text-sm hover:underline" active-class="font-semibold">Журнал</RouterLink>
        <RouterLink to="/review" class="text-sm hover:underline" active-class="font-semibold">
          Проверка фото
          <span v-if="reviewCount" class="ml-1 rounded-full bg-red-600 text-white text-xs px-2 py-0.5">{{ reviewCount }}</span>
        </RouterLink>
```

- [ ] **Step 4: TemplatesPage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type TaskTemplate } from '../api'
import { describeSchedule } from '../lib/schedule'

const templates = ref<TaskTemplate[]>([])
const error = ref('')

async function load() {
  try {
    templates.value = await api.tasks.templates.list(true)
  } catch (err) {
    error.value = errorText(err)
  }
}

async function toggle(t: TaskTemplate) {
  error.value = ''
  try {
    if (t.active) await api.tasks.templates.deactivate(t.id)
    else await api.tasks.templates.activate(t.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

const assignees = (t: TaskTemplate) =>
  t.assignee_mode === 'by_position' ? `Должности: ${t.position_ids.length}` : `Сотрудники: ${t.employee_ids.length}`

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Задания</h1>
      <RouterLink to="/tasks/new" class="btn ml-auto">Новое задание</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr>
          <th class="px-4 py-2">Название</th>
          <th class="px-4 py-2">Расписание</th>
          <th class="px-4 py-2">Кому</th>
          <th class="px-4 py-2">Режим</th>
          <th class="px-4 py-2">Фото</th>
          <th class="px-4 py-2">Статус</th>
          <th class="px-4 py-2"></th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="t in templates" :key="t.id" :class="{ 'text-gray-400': !t.active }">
          <td class="px-4 py-2">{{ t.title }}</td>
          <td class="px-4 py-2">{{ describeSchedule(t.schedule) }}</td>
          <td class="px-4 py-2">{{ assignees(t) }}</td>
          <td class="px-4 py-2">{{ t.distribution === 'each' ? 'Каждому' : 'Одно на всех' }}</td>
          <td class="px-4 py-2">{{ t.requires_photo ? 'Да' : 'Нет' }}</td>
          <td class="px-4 py-2">{{ t.schedule ? (t.active ? 'Активно' : 'Остановлено') : 'Разовое' }}</td>
          <td class="px-4 py-2 text-right space-x-2 whitespace-nowrap">
            <RouterLink :to="`/tasks/${t.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button v-if="t.schedule" class="btn-secondary" @click="toggle(t)">{{ t.active ? 'Остановить' : 'Возобновить' }}</button>
          </td>
        </tr>
        <tr v-if="templates.length === 0">
          <td colspan="7" class="px-4 py-3 text-gray-500">Пока пусто</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 5: TemplateForm.vue**

```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type Employee, type Position, type Schedule, type TaskTemplateInput } from '../api'
import { DAY_LABELS } from '../lib/schedule'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)

const positions = ref<Position[]>([])
const employees = ref<Employee[]>([])
const error = ref('')
const busy = ref(false)

const form = reactive({
  title: '',
  description: '',
  requires_photo: true,
  photo_criteria: '',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position' as 'by_position' | 'by_employees',
  distribution: 'each' as 'each' | 'shared',
  position_ids: [] as number[],
  employee_ids: [] as number[],
  schedule_kind: 'once' as 'once' | 'weekly' | 'interval',
  days: [1, 2, 3, 4, 5, 6, 7] as number[],
  times: ['22:00'] as string[],
  from: '10:00',
  to: '23:00',
  every_minutes: 120,
  deadline_minutes: 60,
})

function toggleDay(d: number) {
  form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]
}

function buildSchedule(): Schedule | null {
  if (form.schedule_kind === 'once') return null
  if (form.schedule_kind === 'weekly') return { kind: 'weekly', days: form.days, times: form.times.filter(Boolean) }
  return { kind: 'interval', days: form.days, from: form.from, to: form.to, every_minutes: Number(form.every_minutes) }
}

function toInput(): TaskTemplateInput {
  return {
    title: form.title,
    description: form.description,
    requires_photo: form.requires_photo,
    photo_criteria: form.requires_photo ? form.photo_criteria : null,
    auto_accept_threshold: Number(form.auto_accept_threshold),
    assignee_mode: form.assignee_mode,
    distribution: form.distribution,
    position_ids: form.position_ids,
    employee_ids: form.employee_ids,
    schedule: buildSchedule(),
    deadline_minutes: Number(form.deadline_minutes),
  }
}

async function load() {
  ;[positions.value, employees.value] = await Promise.all([api.positions.list(), api.employees.list(false)])
  if (!props.id) return
  const t = await api.tasks.templates.get(Number(props.id))
  Object.assign(form, {
    title: t.title, description: t.description, requires_photo: t.requires_photo, photo_criteria: t.photo_criteria ?? '',
    auto_accept_threshold: t.auto_accept_threshold, assignee_mode: t.assignee_mode, distribution: t.distribution,
    position_ids: t.position_ids, employee_ids: t.employee_ids, deadline_minutes: t.deadline_minutes,
    schedule_kind: t.schedule?.kind ?? 'once',
  })
  if (t.schedule) {
    form.days = t.schedule.days
    if (t.schedule.kind === 'weekly') form.times = t.schedule.times
    else Object.assign(form, { from: t.schedule.from, to: t.schedule.to, every_minutes: t.schedule.every_minutes })
  }
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    if (editing.value) {
      await api.tasks.templates.update(Number(props.id), toInput())
      await router.push('/tasks')
      return
    }
    const r = await api.tasks.templates.create(toInput())
    if (r.issued) {
      window.alert(`Выдано: ${r.issued.created}, уведомлено: ${r.issued.notified}`)
      await router.push('/journal')
    } else {
      await router.push('/tasks')
    }
  } catch (err) {
    error.value = errorText(err, { invalid_reference: 'Выбранная должность или сотрудник не существует.' })
  } finally {
    busy.value = false
  }
}

onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-2xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Задание' : 'Новое задание' }}</h1>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <label class="block text-sm">Описание<textarea v-model="form.description" class="input mt-1" rows="2" /></label>
      <label class="flex items-center gap-2 text-sm"><input v-model="form.requires_photo" type="checkbox" /> Требуется фото</label>
      <template v-if="form.requires_photo">
        <label class="block text-sm">
          Что должно быть на фото (критерии для ИИ)
          <textarea v-model="form.photo_criteria" class="input mt-1" rows="3"
            placeholder="Например: группы кофемашины без остатков кофе, холдеры чистые, поддон пустой и сухой" />
        </label>
        <label class="block text-sm">
          Порог автоприёма, 0–100
          <input v-model.number="form.auto_accept_threshold" type="number" min="0" max="100" class="input mt-1 max-w-32" />
          <span class="block text-xs text-gray-500 mt-1">Оценка ИИ не ниже порога принимается без вас, остальное придёт на проверку.</span>
        </label>
      </template>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Кому</div>
      <div class="flex gap-4 text-sm">
        <label class="flex items-center gap-1"><input v-model="form.assignee_mode" type="radio" value="by_position" /> По должностям</label>
        <label class="flex items-center gap-1"><input v-model="form.assignee_mode" type="radio" value="by_employees" /> Поимённо</label>
      </div>
      <div v-if="form.assignee_mode === 'by_position'" class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1">
          <input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}
        </label>
      </div>
      <div v-else class="flex flex-wrap gap-3 text-sm">
        <label v-for="e in employees" :key="e.id" class="flex items-center gap-1">
          <input v-model="form.employee_ids" type="checkbox" :value="e.id" /> {{ e.full_name }}
        </label>
      </div>
      <div class="flex gap-4 text-sm pt-2">
        <label class="flex items-center gap-1"><input v-model="form.distribution" type="radio" value="each" /> Каждому своя копия</label>
        <label class="flex items-center gap-1"><input v-model="form.distribution" type="radio" value="shared" /> Одно на всех, берёт первый</label>
      </div>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Когда</div>
      <div class="flex gap-4 text-sm">
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="once" /> Разовое, сейчас</label>
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="weekly" /> По дням недели</label>
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="interval" /> Каждые N часов</label>
      </div>
      <template v-if="form.schedule_kind !== 'once'">
        <div class="flex gap-1">
          <button v-for="(label, i) in DAY_LABELS" :key="i" type="button" class="btn-secondary"
            :class="{ 'bg-gray-900 text-white': form.days.includes(i + 1) }" @click="toggleDay(i + 1)">{{ label }}</button>
        </div>
        <div v-if="form.schedule_kind === 'weekly'" class="space-y-2">
          <div v-for="(_, i) in form.times" :key="i" class="flex gap-2 items-center">
            <input v-model="form.times[i]" type="time" class="input max-w-40" required />
            <button v-if="form.times.length > 1" type="button" class="btn-secondary" @click="form.times.splice(i, 1)">Убрать</button>
          </div>
          <button type="button" class="btn-secondary" @click="form.times.push('12:00')">+ время</button>
        </div>
        <div v-else class="flex flex-wrap gap-3 items-end text-sm">
          <label>С<input v-model="form.from" type="time" class="input mt-1 max-w-40" required /></label>
          <label>До<input v-model="form.to" type="time" class="input mt-1 max-w-40" required /></label>
          <label>Каждые, минут<input v-model.number="form.every_minutes" type="number" min="15" step="15" class="input mt-1 max-w-32" required /></label>
        </div>
      </template>
      <label class="block text-sm">
        Срок выполнения, минут
        <div class="flex gap-2 items-center mt-1">
          <input v-model.number="form.deadline_minutes" type="number" min="5" class="input max-w-32" required />
          <button v-for="m in [60, 240, 480]" :key="m" type="button" class="btn-secondary" @click="form.deadline_minutes = m">{{ m / 60 }} ч</button>
        </div>
      </label>
    </section>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">{{ editing ? 'Сохранить' : form.schedule_kind === 'once' ? 'Выдать сейчас' : 'Создать' }}</button>
      <RouterLink to="/tasks" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
```

- [ ] **Step 6: InstancesPage.vue**

```vue
<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { api, errorText, type Employee, type InstanceRow, type InstanceStatus, type Submission, type TaskTemplate } from '../api'
import { fmtDate, STATUS_LABEL } from '../lib/schedule'

const rows = ref<InstanceRow[]>([])
const employees = ref<Employee[]>([])
const templates = ref<TaskTemplate[]>([])
const error = ref('')
const filters = reactive<{ status: InstanceStatus | ''; employee_id: number | ''; template_id: number | '' }>({ status: '', employee_id: '', template_id: '' })
const selected = ref<{ instance: InstanceRow; submissions: Submission[] } | null>(null)

const DECISION: Record<string, string> = {
  auto_accepted: 'Принято автоматически',
  needs_review: 'Ждёт владельца',
  owner_accepted: 'Принято владельцем',
  owner_rejected: 'Отклонено владельцем',
}

async function load() {
  error.value = ''
  try {
    rows.value = await api.tasks.instances.list({
      status: filters.status || undefined,
      employee_id: filters.employee_id || undefined,
      template_id: filters.template_id || undefined,
    })
  } catch (err) {
    error.value = errorText(err)
  }
}

async function open(row: InstanceRow) {
  try {
    selected.value = await api.tasks.instances.get(row.id)
  } catch (err) {
    error.value = errorText(err)
  }
}

onMounted(async () => {
  try {
    ;[employees.value, templates.value] = await Promise.all([api.employees.list(true), api.tasks.templates.list(true)])
  } catch (err) {
    error.value = errorText(err)
  }
  await load()
})
watch(filters, load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Журнал заданий</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <div class="flex flex-wrap gap-2">
      <select v-model="filters.status" class="input max-w-48">
        <option value="">Все статусы</option>
        <option v-for="(label, key) in STATUS_LABEL" :key="key" :value="key">{{ label }}</option>
      </select>
      <select v-model="filters.employee_id" class="input max-w-56">
        <option value="">Все сотрудники</option>
        <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.full_name }}</option>
      </select>
      <select v-model="filters.template_id" class="input max-w-64">
        <option value="">Все задания</option>
        <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.title }}</option>
      </select>
    </div>

    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr>
          <th class="px-4 py-2">Задание</th>
          <th class="px-4 py-2">Сотрудник</th>
          <th class="px-4 py-2">Выдано</th>
          <th class="px-4 py-2">Срок</th>
          <th class="px-4 py-2">Статус</th>
          <th class="px-4 py-2">ИИ</th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="r in rows" :key="r.id" class="cursor-pointer hover:bg-gray-50" :class="{ 'text-red-700': r.status === 'overdue' }" @click="open(r)">
          <td class="px-4 py-2">{{ r.title }}</td>
          <td class="px-4 py-2">{{ r.employee_name ?? '—' }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.issued_at) }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td>
          <td class="px-4 py-2">{{ STATUS_LABEL[r.status] }}</td>
          <td class="px-4 py-2">{{ r.last_score ?? '—' }}</td>
        </tr>
        <tr v-if="rows.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>

    <section v-if="selected" class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="flex items-center">
        <h2 class="font-semibold">{{ selected.instance.title }} — {{ selected.instance.employee_name ?? 'не взято' }}</h2>
        <button class="ml-auto btn-secondary" @click="selected = null">Закрыть</button>
      </div>
      <p class="text-sm text-gray-600">
        Статус: {{ STATUS_LABEL[selected.instance.status] }}, срок {{ fmtDate(selected.instance.due_at) }},
        выполнено {{ fmtDate(selected.instance.completed_at) }}
      </p>
      <p v-if="selected.submissions.length === 0" class="text-sm text-gray-500">Сдач пока нет</p>
      <div v-for="s in selected.submissions" :key="s.id" class="border rounded-lg p-3 space-y-2 text-sm">
        <div>{{ fmtDate(s.created_at) }} · {{ s.decision ? DECISION[s.decision] : 'Проверяется' }}</div>
        <div v-if="s.ai_status === 'done'">ИИ: {{ s.ai_score }} из 100. {{ s.ai_verdict }}<span v-if="s.ai_issues.length"> Замечания: {{ s.ai_issues.join('; ') }}</span></div>
        <div v-else-if="s.ai_status === 'failed'" class="text-amber-700">ИИ недоступен</div>
        <div v-if="s.owner_comment">Комментарий владельца: {{ s.owner_comment }}</div>
        <div class="flex gap-2 flex-wrap">
          <template v-for="p in s.photos" :key="p.id">
            <a v-if="!p.deleted_at" :href="`/api/uploads/${p.path}`" target="_blank"><img :src="`/api/uploads/${p.path}`" class="h-32 rounded" /></a>
            <span v-else class="text-gray-400">фото удалено</span>
          </template>
        </div>
      </div>
    </section>
  </div>
</template>
```

- [ ] **Step 7: ReviewPage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type ReviewRow } from '../api'
import { fmtDate } from '../lib/schedule'
import { refreshReviewCount } from '../reviewCount'

const queue = ref<ReviewRow[]>([])
const error = ref('')
const comments = ref<Record<number, string>>({})
const big = ref<Record<number, number>>({})

async function load() {
  try {
    queue.value = await api.tasks.reviewQueue()
    await refreshReviewCount()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function decide(row: ReviewRow, decision: 'accept' | 'reject') {
  error.value = ''
  const comment = comments.value[row.id]?.trim()
  if (decision === 'reject' && !comment) {
    error.value = 'Для отклонения напишите комментарий сотруднику.'
    return
  }
  try {
    await api.tasks.decide(row.id, decision, comment || undefined)
    await load()
  } catch (err) {
    error.value = errorText(err, { already_decided: 'Уже решено (возможно, из бота).' })
    await load()
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Проверка фото</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="queue.length === 0" class="text-sm text-gray-500">Очередь пуста</p>

    <section v-for="row in queue" :key="row.id" class="bg-white rounded-xl shadow p-4 grid gap-4 md:grid-cols-2">
      <div class="space-y-2">
        <img :src="`/api/uploads/${row.photos[big[row.id] ?? 0]?.path}`" class="w-full rounded-lg object-contain max-h-96 bg-gray-100" />
        <div class="flex gap-2">
          <img v-for="(p, i) in row.photos" :key="p.id" :src="`/api/uploads/${p.path}`" class="h-16 rounded cursor-pointer border-2"
            :class="(big[row.id] ?? 0) === i ? 'border-gray-900' : 'border-transparent'" @click="big[row.id] = i" />
        </div>
      </div>
      <div class="space-y-3 text-sm">
        <div class="font-semibold text-base">{{ row.title }}</div>
        <div>{{ row.employee_name }} · {{ fmtDate(row.created_at) }}</div>
        <div v-if="row.photo_criteria" class="text-gray-600">Критерии: {{ row.photo_criteria }}</div>
        <div v-if="row.ai_status === 'done'" class="rounded-lg bg-gray-50 p-3">
          <div>Оценка ИИ: <b>{{ row.ai_score }}</b> из 100</div>
          <div>{{ row.ai_verdict }}</div>
          <ul v-if="row.ai_issues.length" class="list-disc pl-5"><li v-for="(i, k) in row.ai_issues" :key="k">{{ i }}</li></ul>
        </div>
        <div v-else class="rounded-lg bg-amber-50 text-amber-800 p-3">ИИ недоступен, проверьте вручную.</div>
        <textarea v-model="comments[row.id]" class="input" rows="2" placeholder="Комментарий сотруднику (обязателен при отклонении)" />
        <div class="flex gap-2">
          <button class="btn" @click="decide(row, 'accept')">Принять</button>
          <button class="btn-secondary" @click="decide(row, 'reject')">Отклонить</button>
        </div>
      </div>
    </section>
  </div>
</template>
```

- [ ] **Step 8: Сборка и commit**

Run: `npm run build` → Vite и tsc без ошибок и предупреждений (кроме возможного предупреждения о размере чанка, оно допустимо). Run: `npm test` → зелёные.

```bash
git add admin
git commit -m "feat(admin): task templates, journal and photo review pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Сборка процесса, README, ручной прогон

**Files:**
- Modify: `server/index.ts`, `README.md`, `.env.example` (проверить), `docker-compose.yml` (без изменений, только проверить, что `TZ` и `ANTHROPIC_API_KEY` идут из `.env`)

**Interfaces:**
- Consumes: `createReviewer`, `createReviewQueue`, `createScheduler`, `telegramDownloader`, `createTelegramNotifier`, `createBot` с полными `BotDeps`.

- [ ] **Step 1: server/index.ts (полная замена)**

```ts
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Api } from 'grammy'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
import { createBot } from './bot/createBot.js'
import { telegramDownloader } from './bot/files.js'
import { createTelegramNotifier } from './notify.js'
import { createReviewer } from './ai/photoReview.js'
import { createReviewQueue } from './tasks/reviewQueue.js'
import { createScheduler } from './scheduler/tick.js'
import { buildApp } from './app.js'

const config = loadConfig()
mkdirSync(config.DATA_DIR, { recursive: true })
const uploadsDir = join(config.DATA_DIR, 'uploads')
mkdirSync(uploadsDir, { recursive: true })

// dist/server/index.js -> ../../admin/dist; server/index.ts under tsx -> ../admin/dist.
const adminCandidates = [resolve(import.meta.dirname, '../../admin/dist'), resolve(import.meta.dirname, '../admin/dist')]
const adminDistDir = adminCandidates.find(existsSync) ?? adminCandidates[0]!

const db = openDb(join(config.DATA_DIR, 'app.db'))
const auth = createOwnerAuth(db)
const api = new Api(config.BOT_TOKEN)
const notifier = createTelegramNotifier(api, db)
const reviewQueue = createReviewQueue({
  db,
  notifier,
  tz: config.TZ,
  uploadsDir,
  reviewer: createReviewer(config.ANTHROPIC_API_KEY, config.AI_MODEL),
})
const bot = createBot({
  token: config.BOT_TOKEN,
  deps: {
    db,
    ownerPhone: config.OWNER_PHONE,
    publicUrl: config.PUBLIC_URL,
    notifier,
    tz: config.TZ,
    uploadsDir,
    downloadFile: telegramDownloader(config.BOT_TOKEN),
    onSubmission: (id) => reviewQueue.enqueue(id),
    now: () => new Date(),
  },
})
const app = buildApp({ config, db, auth, notifier, uploadsDir, adminDistDir })
const scheduler = createScheduler({ db, notifier, tz: config.TZ, uploadsDir, reviewQueue })

await app.listen({ port: config.PORT, host: '0.0.0.0' })
const stopScheduler = scheduler.start()
bot
  .start({ onStart: (info) => app.log.info(`bot @${info.username} polling, model ${config.AI_MODEL}, tz ${config.TZ}`) })
  .catch((err: unknown) => {
    app.log.error(err, 'bot failed to start, shutting down')
    process.exit(1)
  })

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    stopScheduler()
    await bot.stop()
    await reviewQueue.idle()
    await app.close()
    db.close()
    process.exit(0)
  })
}
```

Run: `npm run typecheck && npm run build` → чисто.

- [ ] **Step 2: README**

В `README.md`:
- В шаге 2 раздела «Запуск в Docker» дописать: `ANTHROPIC_API_KEY` (ключ из console.anthropic.com, нужен для проверки фото), `AI_MODEL` (по умолчанию `claude-sonnet-5`, можно `claude-opus-5`), `TZ` (часовой пояс ресторана: расписания заданий считаются в нём).
- Добавить раздел:
```markdown
## Что умеет

- Сотрудники подключаются к боту по номеру телефона, владелец входит в админку по коду из бота.
- Задания: разовые и по расписанию (дни недели и время либо каждые N минут), каждому сотруднику или одно на всех («Беру»).
- Фото-отчёты до 3 снимков; Claude оценивает их по критериям владельца, оценка не ниже порога принимается автоматически, остальное попадает в очередь «Проверка фото» и владельцу в бот.
- Напоминания, просрочки, журнал заданий, хранение фото 90 дней (`photo_retention_days` в таблице settings).
```

- [ ] **Step 3: Ручной прогон**

Нужны реальные `BOT_TOKEN`, `OWNER_PHONE`, `ANTHROPIC_API_KEY` в `.env`. Запустить `npm run build`, затем сервер (`set -a; source .env; set +a; npm start`) и пройти:
1. Админка → Задания → Новое задание: «Помыть кофемашину», фото, критерии, по должности Бариста, каждому, разовое, срок 60 минут → «Выдано: N».
2. В боте у сотрудника: «Мои задания» → «Открыть» → «Отправить фото» → три снимка → «Готово» → в течение минуты приходит «Принято, N из 100» или «Отправил владельцу на проверку».
3. Если ушло владельцу: в боте пришёл альбом с кнопками; в админке «Проверка фото» показывает тот же элемент; принять в одном месте, во втором должно быть «Уже решено».
4. Создать регулярное задание на ближайшие 2 минуты (по дням недели, время = сейчас + 2 мин) → через 2 минуты приходит уведомление; в Журнале появляется экземпляр.
5. Создать общее задание («одно на всех») на двух сотрудников → у обоих «Беру», у второго после нажатия первым текст меняется на «Взял(а) …».
6. Задание без фото → «Выполнено» → в журнале «Принято».

Владелец не может быть одновременно сотрудником, поэтому для пунктов 2, 3 и 5 нужен второй Telegram-аккаунт, заведённый в админке как сотрудник. Если его нет, отметьте эти пункты в отчёте как непроверенные.

- [ ] **Step 4: Финальная проверка и commit**

Run: `npm test && npm run typecheck && npm run build` → зелёные.

```bash
git add -A
git commit -m "feat: wire review queue and scheduler into the process, document stage 2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
