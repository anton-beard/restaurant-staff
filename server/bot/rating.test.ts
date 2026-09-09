import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { textUpdate, type ApiCall } from '../test/telegram.js'
import type { BotContext } from './states.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let seed: ReturnType<typeof seedRestaurant>
const lastText = () => String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload.text ?? '')

function accepted(employeeId: number, due: string, completed: string) {
  const t = createTaskTemplate(db, {
    title: 'Кофемашина', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  const i = createInstance(db, { template_id: t.id, employee_id: employeeId, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  setInstanceStatus(db, i.id, 'accepted', { completed_at: completed })
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  ;({ bot, calls } = makeBot(db, { now: () => NOW }))
})

describe('my rating', () => {
  it('shows placeholders without data', async () => {
    await bot.handleUpdate(textUpdate(500, 'Мой рейтинг'))
    expect(lastText()).toContain('Пока нет данных для рейтинга.')
    expect(lastText()).toContain('Заданий пока не было.')
    expect(lastText()).toContain('Тестов пока не было.')
  })

  it('shows score, tasks and place', async () => {
    accepted(seed.employees.ivan.id, '2026-09-01T12:00:00.000Z', '2026-09-01T11:00:00.000Z')
    accepted(seed.employees.anna.id, '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z')
    await bot.handleUpdate(textUpdate(500, 'Мой рейтинг'))
    expect(lastText()).toContain('Балл: 100')
    expect(lastText()).toContain('Заданий в срок: 1 из 1')
    expect(lastText()).toContain('Место: 1 из 2')
    await bot.handleUpdate(textUpdate(501, 'Мой рейтинг'))
    expect(lastText()).toContain('Балл: 0')
    expect(lastText()).toContain('Место: 2 из 2')
  })
})

describe('owner summary', () => {
  it('includes today counters and the top 3', async () => {
    accepted(seed.employees.ivan.id, '2026-09-07T05:00:00.000Z', '2026-09-07T04:00:00.000Z')
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(lastText()).toContain('Сегодня: выдано 1, в срок 1, просрочено 0')
    expect(lastText()).toContain('Топ за 30 дней: 1. Иван Петров (100)')
  })
})
