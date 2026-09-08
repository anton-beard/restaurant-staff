import type { Bot } from 'grammy'
import { clearState, setState } from '../db/botStates.js'
import { getCourse } from '../db/courses.js'
import { getQuiz, listQuestions } from '../db/quizzes.js'
import {
  abandonAttempt, completeCourseAssignment, createAttempt, finishAttempt, getAttempt, getCourseAssignment, getOpenAttempt, getQuizAssignmentRow,
  listEmployeeQuizAssignments, markQuizPassed, recordAnswer, type QuizAttempt, type QuizAssignmentRow,
} from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import { isPassed, scoreAnswers } from '../learning/score.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { answersKeyboard, BTN, employeeMenu, startQuizKeyboard } from './keyboards.js'
import { showHome } from './linking.js'
import { discardCollection } from './tasks.js'
import { employeeOf, onState, type BotContext } from './states.js'

/**
 * Отправляет текущий вопрос попытки, при необходимости с предваряющим сообщением.
 * Если вопроса больше нет (тест изменили на ходу), закрывает попытку без оценки, снимает состояние
 * и предлагает начать заново — возвращает false, делать после этого нечего.
 */
export async function askQuestion(ctx: BotContext, deps: BotDeps, attempt: QuizAttempt, notice?: string): Promise<boolean> {
  const row = getQuizAssignmentRow(deps.db, attempt.assignment_id)!
  const questions = listQuestions(deps.db, row.quiz_id)
  const q = questions.find((x) => x.position === attempt.current_question)
  if (!q) {
    abandonAttempt(deps.db, attempt.id, deps.now().toISOString())
    clearState(deps.db, ctx.from!.id)
    const canRestart = row.status === 'pending' || row.status === 'overdue'
    await ctx.reply('Тест изменился, начните его заново.', { reply_markup: canRestart ? startQuizKeyboard(row.id) : employeeMenu() })
    return false
  }
  if (notice) await ctx.reply(notice)
  await ctx.reply(`Вопрос ${q.position} из ${questions.length}:\n${q.text}`, { reply_markup: answersKeyboard(attempt.id, q.position, q.options) })
  return true
}

export function registerQuizStates(bot: Bot<BotContext>, deps: BotDeps): void {
  onState(bot, 'quiz', async (ctx, next) => {
    const attempt = getAttempt(deps.db, ctx.state.attempt_id)
    if (!attempt || attempt.finished_at) {
      clearState(deps.db, ctx.from!.id)
      return next()
    }
    // «Отмена» и /start откладывают тест: попытка остаётся открытой, меню снова доступно
    const text = ctx.message.text?.trim().toLowerCase() ?? ''
    if (text === BTN.cancel.toLowerCase() || text === '/start' || text.startsWith('/start ')) {
      clearState(deps.db, ctx.from!.id)
      await ctx.reply('Тест отложен. Продолжить можно через «Тесты».', { reply_markup: employeeMenu() })
      return
    }
    await askQuestion(ctx, deps, attempt, `Идёт тест, ответьте на вопрос ${attempt.current_question}.`)
  })
}

export function registerQuiz(bot: Bot<BotContext>, deps: BotDeps): void {
  const { db } = deps

  async function finish(ctx: BotContext, attempt: QuizAttempt, row: QuizAssignmentRow): Promise<void> {
    const questions = listQuestions(db, row.quiz_id)
    const quiz = getQuiz(db, row.quiz_id)!
    const { correct, total, score } = scoreAnswers(attempt.answers, questions)
    const passed = isPassed(score, quiz.pass_score)
    const nowIso = deps.now().toISOString()
    finishAttempt(db, attempt.id, score, passed, nowIso)
    clearState(db, ctx.from!.id)
    if (!passed) {
      await deps.notifier.toOwner(`${row.employee_name} не сдал(а) тест «${row.title}»: ${score} из 100.`)
      await ctx.reply(`Не сдано: правильных ${correct} из ${total}, нужно ${quiz.pass_score}%.`, { reply_markup: startQuizKeyboard(row.id, 'Пересдать') })
      return
    }
    markQuizPassed(db, row.id, nowIso)
    if (row.course_assignment_id !== null) {
      completeCourseAssignment(db, row.course_assignment_id, nowIso)
      const ca = getCourseAssignment(db, row.course_assignment_id)
      const course = ca ? getCourse(db, ca.course_id) : null
      await deps.notifier.toOwner(`${row.employee_name} прошёл(а) курс «${course?.title ?? row.title}» (${score} из 100).`)
    }
    await ctx.reply(`Сдано! ${score} из 100.`, { reply_markup: employeeMenu() })
  }

  bot.hears(BTN.quizzes, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return showHome(ctx, deps)
    // во время теста сюда не попадаем: сообщение перехватывает обработчик состояния quiz
    const rows = listEmployeeQuizAssignments(db, emp.id)
    if (rows.length === 0) return void (await ctx.reply('Тестов нет.', { reply_markup: employeeMenu() }))
    for (const row of rows) {
      const suffix = row.status === 'overdue' ? ', просрочен' : ''
      await ctx.reply(`«${row.title}», до ${formatLocal(new Date(row.due_at), deps.tz, deps.now())}${suffix}`, {
        reply_markup: startQuizKeyboard(row.id, row.open_attempt_id ? 'Продолжить' : 'Начать'),
      })
    }
  })

  bot.callbackQuery(CB_RE.quizStart, async (ctx) => {
    const emp = employeeOf(ctx)
    const row = getQuizAssignmentRow(db, Number(ctx.match[1]))
    if (!emp || !row || row.employee_id !== emp.id) return ctx.answerCallbackQuery({ text: 'Это не ваш тест.' })
    if (row.status === 'passed') return ctx.answerCallbackQuery({ text: 'Тест уже сдан.' })
    const attempt = getOpenAttempt(db, row.id) ?? createAttempt(db, row.id, deps.now().toISOString())
    // из режима сбора фото уходим начисто: сдачи не будет, файлы осиротеют
    if (ctx.state?.kind === 'collecting_photos') discardCollection(deps, ctx.state)
    setState(db, ctx.from.id, { kind: 'quiz', attempt_id: attempt.id })
    await ctx.answerCallbackQuery()
    await askQuestion(ctx, deps, attempt)
  })

  bot.callbackQuery(CB_RE.quizAnswer, async (ctx) => {
    const emp = employeeOf(ctx)
    const attemptId = Number(ctx.match[1])
    const attempt = getAttempt(db, attemptId)
    const row = attempt ? getQuizAssignmentRow(db, attempt.assignment_id) : null
    if (!emp || !attempt || !row || row.employee_id !== emp.id) return ctx.answerCallbackQuery({ text: 'Это не ваш тест.' })
    if (!recordAnswer(db, attemptId, Number(ctx.match[2]), Number(ctx.match[3]))) return ctx.answerCallbackQuery({ text: 'Уже отвечено.' })
    await ctx.answerCallbackQuery()
    const fresh = getAttempt(db, attemptId)!
    const total = listQuestions(db, row.quiz_id).length
    if (fresh.current_question <= total) {
      await askQuestion(ctx, deps, fresh)
      return
    }
    await finish(ctx, fresh, row)
  })
}
