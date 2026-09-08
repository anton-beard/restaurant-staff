import { describe, expect, it } from 'vitest'
import { openDb } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { getCourseAssignment, listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { publishCourse } from '../db/courses.js'
import { assignCourse } from '../learning/assign.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import { callbackUpdate, textUpdate } from '../test/telegram.js'
import { CB } from './callbacks.js'

describe('learning end to end', () => {
  it('publish → assignment notification → lessons → quiz → owner notified', async () => {
    const db = openDb(':memory:')
    const seed = seedRestaurant(db)
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const NOW = new Date('2026-09-07T10:00:00.000Z')
    const { bot, calls, notifier } = makeBot(db, { now: () => NOW })
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const published = publishCourse(db, course.id, true, NOW.toISOString())!
    expect(await assignCourse({ db, notifier, tz: 'Europe/Moscow' }, published, NOW, false)).toBe(2)
    const ivan = listCourseAssignments(db, { employee_id: seed.employees.ivan.id })[0]!
    expect(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === 500 && String(c.payload.text).includes('Новый курс'))).toBe(true)

    await bot.handleUpdate(textUpdate(500, 'Обучение'))
    await bot.handleUpdate(callbackUpdate(500, CB.courseContinue(ivan.id)))
    for (const lesson of [1, 2, 3]) await bot.handleUpdate(callbackUpdate(500, CB.courseNext(ivan.id, lesson)))
    const qa = listQuizAssignments(db, { employee_id: seed.employees.ivan.id })[0]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(qa.id)))
    const attemptId = Number(String(calls.at(-1)!.payload.reply_markup && JSON.stringify(calls.at(-1)!.payload.reply_markup)).match(/quiz:answer:(\d+):1:0/)![1])
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attemptId, 1, 1)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attemptId, 2, 0)))

    expect(getCourseAssignment(db, ivan.id)?.status).toBe('completed')
    expect(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === 42 && String(c.payload.text).includes('прошёл(а) курс'))).toBe(true)
    expect(calls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === 500 && String(c.payload.text).startsWith('Сдано!'))).toBe(true)
  })
})
