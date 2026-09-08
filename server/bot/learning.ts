import { resolve, sep } from 'node:path'
import { InputFile, type Bot } from 'grammy'
import { getLesson } from '../db/courses.js'
import { getCourseQuiz } from '../db/quizzes.js'
import {
  advanceLesson, createQuizAssignment, findQuizAssignmentForCourse, getCourseAssignmentRow,
  listEmployeeCourseAssignments, type CourseAssignment, type CourseAssignmentRow, type QuizAssignment,
} from '../db/learningAssignments.js'
import type { Db } from '../db/connect.js'
import { formatLocal } from '../lib/time.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { BTN, continueCourseKeyboard, employeeMenu, nextLessonKeyboard, startQuizKeyboard } from './keyboards.js'
import { showHome } from './linking.js'
import { employeeOf, type BotContext } from './states.js'

/** Абсолютный путь к файлу внутри uploadsDir или null, если путь выходит за его пределы. */
export function resolveUpload(uploadsDir: string, relPath: string): string | null {
  const root = resolve(uploadsDir)
  const full = resolve(root, relPath)
  return full === root || !full.startsWith(root + sep) ? null : full
}

/** Итоговый тест курса: создаётся один раз, повторный вызов возвращает существующее назначение. */
export function ensureCourseQuizAssignment(db: Db, assignment: CourseAssignment, nowIso: string): QuizAssignment {
  const existing = findQuizAssignmentForCourse(db, assignment.id)
  if (existing) return existing
  const quiz = getCourseQuiz(db, assignment.course_id)
  if (!quiz) throw new Error(`course ${assignment.course_id} has no quiz`)
  return (
    createQuizAssignment(db, {
      quiz_id: quiz.id, employee_id: assignment.employee_id, course_assignment_id: assignment.id,
      slot_at: nowIso, assigned_at: nowIso, due_at: assignment.due_at,
    }) ?? findQuizAssignmentForCourse(db, assignment.id)!
  )
}

export async function sendLesson(ctx: BotContext, deps: BotDeps, row: CourseAssignmentRow): Promise<void> {
  const lesson = getLesson(deps.db, row.course_id, row.current_lesson)
  if (!lesson) {
    await ctx.reply('Уроки пройдены, остался итоговый тест.')
    return
  }
  await ctx.reply(`Урок ${lesson.position} из ${row.lesson_count}: ${lesson.title}\n\n${lesson.body}`.trim())
  for (const m of lesson.media) {
    if (m.kind === 'image') {
      const full = resolveUpload(deps.uploadsDir, m.path)
      if (!full) {
        console.warn('lesson media path rejected', m.path)
        continue
      }
      await ctx.replyWithPhoto(new InputFile(full))
    } else await ctx.reply(m.url)
  }
  await ctx.reply('Нажмите, когда прочитаете.', { reply_markup: nextLessonKeyboard(row.id, lesson.position) })
}

export function registerLearning(bot: Bot<BotContext>, deps: BotDeps): void {
  const { db } = deps

  async function ownAssignment(ctx: BotContext, id: number): Promise<CourseAssignmentRow | null> {
    const emp = employeeOf(ctx)
    const row = getCourseAssignmentRow(db, id)
    if (!emp || !row || row.employee_id !== emp.id) {
      await ctx.answerCallbackQuery({ text: 'Это не ваш курс.' })
      return null
    }
    if (row.status === 'completed') {
      await ctx.answerCallbackQuery({ text: 'Курс уже завершён.' })
      return null
    }
    return row
  }

  async function offerQuiz(ctx: BotContext, row: CourseAssignmentRow): Promise<void> {
    const qa = ensureCourseQuizAssignment(db, row, deps.now().toISOString())
    await ctx.reply('Уроки пройдены, остался итоговый тест.', { reply_markup: startQuizKeyboard(qa.id, 'Пройти тест') })
  }

  bot.hears(BTN.learning, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return showHome(ctx, deps)
    const rows = listEmployeeCourseAssignments(db, emp.id)
    if (rows.length === 0) {
      await ctx.reply('Курсов нет.', { reply_markup: employeeMenu() })
      return
    }
    for (const row of rows) {
      if (row.status === 'completed') {
        await ctx.reply(`Пройдено: «${row.title}»`)
        continue
      }
      const due = formatLocal(new Date(row.due_at), deps.tz, deps.now())
      const suffix = row.status === 'overdue' ? ', просрочен' : ''
      await ctx.reply(`«${row.title}», урок ${Math.min(row.current_lesson, row.lesson_count)} из ${row.lesson_count}, до ${due}${suffix}`, {
        reply_markup: continueCourseKeyboard(row.id),
      })
    }
  })

  bot.callbackQuery(CB_RE.courseContinue, async (ctx) => {
    const row = await ownAssignment(ctx, Number(ctx.match[1]))
    if (!row) return
    await ctx.answerCallbackQuery()
    if (row.current_lesson > row.lesson_count) return offerQuiz(ctx, row)
    await sendLesson(ctx, deps, row)
  })

  bot.callbackQuery(CB_RE.courseNext, async (ctx) => {
    const row = await ownAssignment(ctx, Number(ctx.match[1]))
    if (!row) return
    const lesson = Number(ctx.match[2])
    if (row.current_lesson > row.lesson_count && lesson === row.lesson_count) {
      await ctx.answerCallbackQuery()
      return offerQuiz(ctx, row)
    }
    if (!advanceLesson(db, row.id, lesson)) return ctx.answerCallbackQuery({ text: 'Уже отмечено.' })
    await ctx.answerCallbackQuery()
    const fresh = getCourseAssignmentRow(db, row.id)!
    if (fresh.current_lesson > fresh.lesson_count) return offerQuiz(ctx, fresh)
    await sendLesson(ctx, deps, fresh)
  })
}
