import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot, BotError } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { createPosition } from '../db/positions.js'
import { archiveEmployee, createEmployee, getEmployee, linkTelegram } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { contactUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { makeBot, OWNER_PHONE } from '../test/bot.js'

let db: Db
let bot: Bot
let calls: ApiCall[]

beforeEach(() => {
  db = openDb(':memory:')
  ;({ bot, calls } = makeBot(db))
  createPosition(db, 'Официант')
  createEmployee(db, { full_name: 'Иван Петров', phone: '+79990000001', position_id: 1 })
})

const lastText = () => String(calls.at(-1)?.payload.text ?? '')
const lastMarkup = () => JSON.stringify(calls.at(-1)?.payload.reply_markup ?? {})

describe('linking', () => {
  it('asks an unknown user for the contact', async () => {
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(calls.at(-1)?.method).toBe('sendMessage')
    expect(lastMarkup()).toContain('"request_contact":true')
  })

  it('rejects a contact of another user', async () => {
    await bot.handleUpdate(contactUpdate(500, '+79990000001', 501))
    expect(lastText()).toMatch(/свой номер/i)
    expect(getEmployee(db, 1)?.telegram_id).toBeNull()
  })

  it('links the owner by OWNER_PHONE', async () => {
    await bot.handleUpdate(contactUpdate(42, '79990000000'))
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBe('42')
    expect(lastText()).toMatch(/владелец/i)
  })

  it('links an invited employee and notifies the owner', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await bot.handleUpdate(contactUpdate(500, '+7 999 000-00-01'))
    expect(getEmployee(db, 1)).toMatchObject({ status: 'active', telegram_id: 500 })
    const toOwner = calls.find((c) => c.payload.chat_id === 42)
    expect(String(toOwner?.payload.text)).toMatch(/Иван Петров/)
    const toEmployee = calls.find((c) => c.payload.chat_id === 500)
    expect(JSON.stringify(toEmployee?.payload.reply_markup)).toContain('Мои задания')
  })

  it('rejects an unknown phone', async () => {
    await bot.handleUpdate(contactUpdate(500, '+79990009999'))
    expect(lastText()).toMatch(/не добавили/i)
  })

  it('rejects a phone already linked to another account', async () => {
    linkTelegram(db, 1, 777)
    await bot.handleUpdate(contactUpdate(500, '+79990000001'))
    expect(lastText()).toMatch(/другому аккаунту/i)
    expect(getEmployee(db, 1)?.telegram_id).toBe(777)
  })

  it('rejects a telegram account already linked to another employee', async () => {
    createEmployee(db, { full_name: 'Пётр Сидоров', phone: '+79990000002', position_id: 1 })
    linkTelegram(db, 1, 500)
    await bot.handleUpdate(contactUpdate(500, '+79990000002'))
    expect(lastText()).toMatch(/уже привязан к другому сотруднику/i)
    expect(getEmployee(db, 2)).toMatchObject({ status: 'invited', telegram_id: null })
  })

  it('rejects a telegram account already linked to an archived employee', async () => {
    createEmployee(db, { full_name: 'Пётр Сидоров', phone: '+79990000002', position_id: 1 })
    linkTelegram(db, 1, 500)
    archiveEmployee(db, 1)
    await bot.handleUpdate(contactUpdate(500, '+79990000002'))
    expect(lastText()).toMatch(/другому сотруднику/i)
    expect(getEmployee(db, 2)?.telegram_id).toBeNull()
  })

  it('rejects the phone of an archived employee', async () => {
    archiveEmployee(db, 1)
    await bot.handleUpdate(contactUpdate(500, '+79990000001'))
    expect(lastText()).toMatch(/не добавили/i)
    expect(getEmployee(db, 1)?.telegram_id).toBeNull()
  })

  it('moves the owner to a new telegram account', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await bot.handleUpdate(contactUpdate(43, '+79990000000'))
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBe('43')
  })
})

describe('errors', () => {
  it('answers with an apology when a handler throws', async () => {
    const { bot: failing, calls: failingCalls } = makeBot(db)
    // Installed last, so it wraps the capture: the first reply fails, the apology is recorded.
    let fail = true
    failing.api.config.use(async (prev, method, payload, signal) => {
      if (fail) {
        fail = false
        throw new Error('boom')
      }
      return prev(method, payload, signal)
    })
    // handleUpdate rethrows; the polling loop is what feeds errors to bot.catch.
    await failing
      .handleUpdate(textUpdate(500, '/start'))
      .catch((err: unknown) => failing.errorHandler(err as BotError))
    expect(String(failingCalls.at(-1)?.payload.text ?? '')).toMatch(/пошло не так/i)
  })
})

describe('menus', () => {
  it('shows the employee menu on /start and answers menu buttons', async () => {
    linkTelegram(db, 1, 500)
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(lastMarkup()).toContain('Мои задания')
  })

  it('shows the owner summary with the admin link', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(lastText()).toMatch(/Приглашены: 1/)
    expect(lastText()).toContain('https://admin.example')
  })
})
