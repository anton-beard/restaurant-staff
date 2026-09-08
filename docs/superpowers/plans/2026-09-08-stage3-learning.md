# Этап 3: курсы, уроки, тесты. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец создаёт курсы (уроки + итоговый тест) и отдельные тесты по расписанию, система назначает их сотрудникам по должностям, сотрудники проходят уроки и тесты в боте, владелец видит прогресс.

**Architecture:** Тот же процесс. Явный маршрутизатор состояний диалога и роли (один запрос на апдейт) заменяет разрозненные проверки `getState` в модулях бота. Миграция `003_learning` добавляет курсы, уроки, тесты, вопросы, назначения и попытки; попытка теста в базе и есть состояние прохождения. Сервис назначений используется API (публикация, «выдать сейчас») и планировщиком (новые сотрудники, расписание тестов, напоминания, просрочки). Картинки уроков загружаются через JSON с base64 в существующую папку `uploads/` и отдаются владельцу через `/api/uploads/*`, боту — с диска.

**Tech Stack:** как в этапах 1–2; новых зависимостей нет.

Спек: `docs/superpowers/specs/2026-09-08-stage3-learning-design.md`. Паттерны кода: `db` первым аргументом, zod через `parse()`, тесты рядом с кодом, `buildTestApp` для API, `makeBot` + `handleUpdate` для бота, `fakeNotifier` для уведомлений, `seedRestaurant` для данных (должности Повар/Администратор/Бариста, сотрудники Иван 500 и Анна 501 бариста, Пётр 502 повар, Ольга без Telegram).

## Global Constraints

- Node.js ≥ 24, ESM, TypeScript strict, `verbatimModuleSyntax`.
- Миграция `003_learning` добавляется в массив в `server/db/migrations.ts`; сотрудник получает колонки `linked_at`, `position_changed_at` (backfill = `created_at`).
- Вопрос: один правильный из 2–5 вариантов; балл `round(правильных / всего * 100)`, сдано при `score >= pass_score` (по умолчанию 80).
- Курс: статусы `draft` | `published` | `archived`; публикация требует ≥ 1 урок, ≥ 1 вопрос итогового теста, ≥ 1 должность; при `assign_existing` назначается всем активным сотрудникам должностей курса, иначе только тем, у кого `max(linked_at, position_changed_at) > published_at`.
- Назначение курса: `due_at = assigned_at + due_days`; тест курса создаётся после последнего урока со `slot_at` = момент завершения и `due_at` курса. Отдельный тест: расписание только `weekly`, `due_at = slot + deadline_minutes`, пропущенный слот старше 60 минут не выдаётся.
- Пересдачи не ограничены; одна незавершённая попытка на назначение; просрочка (`overdue`) не мешает завершению.
- Напоминания один раз: курс за 24 часа до срока (если срок > 48 часов, иначе за половину), тест за половину срока.
- Все `/api/learning/*` за сессией владельца; картинки уроков jpg/png/webp до 5 МБ.
- Тексты бота и админки на русском; поведение этапов 1–2 не меняется, их тесты остаются зелёными.
- Коммиты от локального автора, без remote/push, сообщения заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `.env` не читать и не коммитить.

## Структура файлов

```
server/bot/states.ts               BotContext, BotState, middleware ролей/состояний, onState
server/bot/tasks.ts, review.ts     переводятся на ctx.role / ctx.state / onState
server/bot/learning.ts             «Обучение»: список, урок, «Дальше», переход к тесту
server/bot/quiz.ts                 «Тесты»: попытки, ответы, результат, состояние quiz
server/bot/callbacks.ts, keyboards.ts   + курсы и тесты
server/db/migrations.ts            + 003_learning
server/db/employees.ts             linked_at, position_changed_at
server/db/courses.ts               курсы и уроки
server/db/quizzes.ts               тесты и вопросы
server/db/learningAssignments.ts   назначения курсов/тестов и попытки
server/learning/score.ts           подсчёт балла
server/learning/assign.ts          назначение курсов, выдача тестов, уведомления
server/scheduler/learning.ts       assignCourses, issueDueQuizzes, learningReminders, learningOverdue
server/scheduler/tick.ts           + шаги обучения
server/api/learning.ts             /api/learning/*
server/test/learning.ts            фабрики курса/теста для тестов
admin/src/api.ts, router.ts, components/AppLayout.vue
admin/src/pages/CoursesPage.vue, CourseForm.vue, QuizzesPage.vue, QuizForm.vue, ProgressPage.vue
admin/src/components/QuestionsEditor.vue
```

---

### Task 1: Маршрутизатор состояний и ролей

**Files:**
- Create: `server/bot/states.ts`, `server/bot/states.test.ts`
- Modify: `server/bot/createBot.ts`, `server/bot/tasks.ts`, `server/bot/review.ts`, `server/bot/linking.ts`, `server/test/bot.ts`

**Interfaces:**
- Produces (`states.ts`):
  ```ts
  type CollectingState = { kind: 'collecting_photos'; instance_id: number; photos: { path: string; fileUniqueId: string }[] }
  type RejectState = { kind: 'reject_comment'; submission_id: number }
  type QuizState = { kind: 'quiz'; attempt_id: number }
  type BotState = CollectingState | RejectState | QuizState
  type BotContext = Context & { role: Role; state: BotState | null }
  type StateHandler<K extends BotState['kind']> = (ctx: BotContext & { state: Extract<BotState, { kind: K }>; message: Message }, next: () => Promise<void>) => Promise<void> | void
  registerContextMiddleware(bot: Bot<BotContext>, deps: BotDeps): void   // ctx.role, ctx.state один раз на апдейт
  onState<K>(bot: Bot<BotContext>, kind: K, handler: StateHandler<K>): void  // только для message-апдейтов с этим kind; callback-запросы и другие kind пропускаются дальше
  employeeOf(ctx: BotContext): Employee | null
  ```
- `createBot` возвращает `Bot<BotContext>`; порядок регистрации: `registerContextMiddleware` → обработчики состояний (`registerTaskStates`, `registerReviewStates`) → `registerLinking` → `registerTasks` → `registerReview` → `registerFallback`.
- `tasks.ts` экспортирует `registerTaskStates(bot, deps)` (сбор фото) и `registerTasks(bot, deps)` (список, карточка, callbacks, фото вне состояния); `review.ts` экспортирует `registerReviewStates` (комментарий) и `registerReview` (callbacks). `CollectingState` теперь импортируется из `states.ts`.
- Поведение этапа 2 не меняется, кроме одного уточнения: во время сбора фото любое сообщение (включая кнопки меню и `/start`) получает подсказку про «Готово»/«Отмена» вместо главного меню.

- [ ] **Step 1: Тест маршрутизатора**

`server/bot/states.test.ts`:
```ts
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
```

Run: `npx vitest run server/bot/states.test.ts` → FAIL (модуль не найден).

- [ ] **Step 2: server/bot/states.ts**

```ts
import type { Bot, Context, NextFunction } from 'grammy'
import type { Message } from 'grammy/types'
import { getState } from '../db/botStates.js'
import type { Employee } from '../db/employees.js'
import type { BotDeps } from './deps.js'
import { roleOf, type Role } from './roles.js'

export type CollectingState = {
  kind: 'collecting_photos'
  instance_id: number
  photos: { path: string; fileUniqueId: string }[]
}
export type RejectState = { kind: 'reject_comment'; submission_id: number }
export type QuizState = { kind: 'quiz'; attempt_id: number }
export type BotState = CollectingState | RejectState | QuizState
export type StateKind = BotState['kind']

export type BotContext = Context & { role: Role; state: BotState | null }

export type StateHandler<K extends StateKind> = (
  ctx: BotContext & { state: Extract<BotState, { kind: K }>; message: Message },
  next: NextFunction,
) => Promise<void> | void

/** Роль и состояние диалога резолвятся один раз на апдейт. */
export function registerContextMiddleware(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      ctx.role = roleOf(deps.db, ctx.from.id)
      ctx.state = getState<BotState>(deps.db, ctx.from.id)
    } else {
      ctx.role = { kind: 'unknown' }
      ctx.state = null
    }
    await next()
  })
}

/** Обработчик сообщений для одного вида состояния. Callback-запросы и другие состояния идут дальше. */
export function onState<K extends StateKind>(bot: Bot<BotContext>, kind: K, handler: StateHandler<K>): void {
  bot.use(async (ctx, next) => {
    if (!ctx.message || ctx.state?.kind !== kind) return next()
    await handler(ctx as Parameters<StateHandler<K>>[0], next)
  })
}

export function employeeOf(ctx: BotContext): Employee | null {
  return ctx.role.kind === 'employee' ? ctx.role.employee : null
}
```

Run: `npx vitest run server/bot/states.test.ts` → 3 passed.

- [ ] **Step 3: Перевести tasks.ts**

В `server/bot/tasks.ts`:
- Удалить локальные `CollectingState`, `collecting()` и `employeeOf()`; импортировать `type BotContext, type CollectingState, employeeOf, onState` из `./states.js`; `Bot` → `Bot<BotContext>`, `Context` → `BotContext` в сигнатурах `sendCard`, `ownPending`, `finishCollection`, `cancelCollection`.
- Новая функция `registerTaskStates(bot: Bot<BotContext>, deps: BotDeps)`, куда переносятся обработка фото в состоянии, «Готово», «Отмена» и подсказка, в одном `onState(bot, 'collecting_photos', ...)`:
```ts
export function registerTaskStates(bot: Bot<BotContext>, deps: BotDeps): void {
  const { db } = deps
  onState(bot, 'collecting_photos', async (ctx) => {
    const state = ctx.state
    if (ctx.message.photo) {
      if (state.photos.length >= 3) return ctx.reply('Максимум 3 фото.')
      const best = ctx.message.photo.at(-1)!
      const dup = photoExists(db, best.file_unique_id) || state.photos.some((p) => p.fileUniqueId === best.file_unique_id)
      if (dup) return ctx.reply('Это фото уже отправляли, снимите заново.')
      const file = await ctx.getFile()
      if (!file.file_path) throw new Error('telegram returned no file_path')
      const data = await deps.downloadFile(file.file_path)
      const n = state.photos.length + 1
      const rel = join(String(state.instance_id), `${deps.now().getTime()}-${n}.jpg`)
      mkdirSync(join(deps.uploadsDir, String(state.instance_id)), { recursive: true })
      writeFileSync(join(deps.uploadsDir, rel), data)
      state.photos.push({ path: rel, fileUniqueId: best.file_unique_id })
      setState(db, ctx.from!.id, state)
      await ctx.reply(`Фото ${n} из 3 получено.`)
      return
    }
    const text = ctx.message.text?.trim().toLowerCase()
    if (text === BTN.photosDone.toLowerCase()) return finishCollection(ctx, deps, state)
    if (text === BTN.cancel.toLowerCase()) return cancelCollection(ctx, deps, state)
    await ctx.reply('Сейчас идёт отправка фото. Пришлите фото, затем нажмите Готово, или нажмите Отмена.', {
      reply_markup: photoCollectKeyboard(),
    })
  })
}
```
  `finishCollection` и `cancelCollection` становятся функциями уровня модуля с сигнатурой `(ctx: BotContext, deps: BotDeps, state: CollectingState)`.
- В `registerTasks` остаются: `hears(BTN.tasks)`, callbacks `open/done/photo/claim` (с `employeeOf(ctx)` из `states.ts`), и `bot.on('message:photo')` только для случая без состояния: если `employeeOf(ctx)` → «Сначала откройте задание и нажмите «Отправить фото».», иначе `next()`. Старые `hears(BTN.photosDone)`, `hears(BTN.cancel)` и catch-all `bot.on('message')` удаляются.

- [ ] **Step 4: Перевести review.ts**

- `registerReviewStates(bot, deps)`: `onState(bot, 'reject_comment', ...)`: если `ctx.role.kind !== 'owner'` → `clearState` и `next()`; текст `Отмена` (без учёта регистра) → `clearState`, «Отменено.» с `ownerMenu()`; пустой/непустой комментарий как сейчас (`applyOwnerDecision`, «Отклонено, сотруднику отправлено.» / «Уже решено.»); не текст (фото и т.п.) → «Напишите комментарий для сотрудника.» с `cancelKeyboard()`.
- `registerReview` оставляет только callbacks `accept`/`reject` с `isOwner = ctx.role.kind === 'owner'`. Локальные `RejectState`, `rejectState()`, `hears(BTN.cancel)` и `on('message:text')` удаляются.

- [ ] **Step 5: linking.ts и createBot.ts**

`linking.ts`: типы `Bot<BotContext>`; `showHome` по-прежнему вызывает `roleOf` заново (после привязки роль в `ctx.role` устарела). `registerLinking` и `registerFallback` без изменений поведения.

`createBot.ts`:
```ts
import { Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { normalizePhone } from '../lib/phone.js'
import type { BotDeps } from './deps.js'
import { registerFallback, registerLinking } from './linking.js'
import { registerReview, registerReviewStates } from './review.js'
import { registerContextMiddleware, type BotContext } from './states.js'
import { registerTaskStates, registerTasks } from './tasks.js'

export type BotOptions = { token: string; botInfo?: UserFromGetMe; deps: BotDeps }

export function createBot(opts: BotOptions): Bot<BotContext> {
  const ownerPhone = normalizePhone(opts.deps.ownerPhone)
  if (!ownerPhone) throw new Error('OWNER_PHONE is not a valid phone number')
  const deps: BotDeps = { ...opts.deps, ownerPhone }

  const bot = new Bot<BotContext>(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined)

  registerContextMiddleware(bot, deps)
  registerTaskStates(bot, deps)
  registerReviewStates(bot, deps)
  registerLinking(bot, deps)
  registerTasks(bot, deps)
  registerReview(bot, deps)
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

`server/test/bot.ts`: тип возвращаемого бота меняется автоматически; `captureApi` принимает `Bot<BotContext>` (в `server/test/telegram.ts` параметр `target: Api | Bot<any>` — заменить тип на `Api | Bot<Context>` через `import type { Context }` или `Bot<any>`; выбрать `Bot<Context>` с приведением при использовании).

- [ ] **Step 6: Все тесты бота зелёные**

Run: `npx vitest run server/bot` → все passed, включая `tasks.test.ts`, `review.test.ts`, `e2e.test.ts`, `createBot.test.ts`. Если тест «stray text keeps the collecting keyboard» проверяет отправку «Обучение» во время сбора фото и ожидает «Раздел появится…», обновить ожидание на подсказку про «Готово»/«Отмена» (это заявленное уточнение поведения).

Run: `npm test && npm run typecheck` → зелёные.

- [ ] **Step 7: Commit**

```bash
git add server/bot server/test
git commit -m "refactor(bot): explicit dialogue state router and per-update role resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Миграция и репозитории обучения

**Files:**
- Modify: `server/db/migrations.ts` (+ `003_learning`), `server/db/employees.ts` (`linked_at`, `position_changed_at`), `server/db/repos.test.ts`
- Create: `server/db/courses.ts`, `server/db/quizzes.ts`, `server/db/learningAssignments.ts`, `server/learning/score.ts`, `server/learning/score.test.ts`, `server/db/learning.test.ts`, `server/test/learning.ts`

**Interfaces:**
- `Employee` += `linked_at: string | null`, `position_changed_at: string`. `linkTelegram` проставляет `linked_at = now` (SQL `strftime`), `updateEmployee` проставляет `position_changed_at` при смене `position_id`.
- `courses.ts`:
  ```ts
  type CourseStatus = 'draft' | 'published' | 'archived'
  type Media = { kind: 'image'; path: string } | { kind: 'video'; url: string }
  type Lesson = { id: number; course_id: number; position: number; title: string; body: string; media: Media[] }
  type LessonInput = { title: string; body: string; media: Media[] }
  type Course = { id; title; description; due_days; pass_score; status: CourseStatus; published_at: string | null; assign_existing: boolean; created_at; position_ids: number[]; lesson_count: number }
  type CourseInput = { title; description; due_days; pass_score; position_ids: number[] }
  createCourse(db, input): Course; updateCourse(db, id, input): Course | null; getCourse(db, id): Course | null
  listCourses(db, opts?: { includeArchived?: boolean }): Course[]; listPublishedCourses(db): Course[]
  publishCourse(db, id, assignExisting: boolean, nowIso): Course | null       // status published, published_at, assign_existing
  setCourseStatus(db, id, status: CourseStatus): Course | null
  replaceLessons(db, courseId, lessons: LessonInput[]): void; listLessons(db, courseId): Lesson[]; getLesson(db, courseId, position): Lesson | null
  ```
- `quizzes.ts`:
  ```ts
  type QuizStatus = 'draft' | 'published' | 'archived'
  type Question = { id; quiz_id; position; text; options: string[]; correct_index: number }
  type QuestionInput = { text: string; options: string[]; correct_index: number }
  type Quiz = { id; title; course_id: number | null; pass_score; schedule: Schedule | null; deadline_minutes: number | null; status; next_run_at: string | null; created_at; position_ids: number[]; question_count: number }
  type QuizInput = { title; course_id: number | null; pass_score; schedule: Schedule | null; deadline_minutes: number | null; position_ids: number[] }
  createQuiz(db, input, nextRunAt: string | null): Quiz; updateQuiz(db, id, input, nextRunAt): Quiz | null; getQuiz(db, id): Quiz | null
  getCourseQuiz(db, courseId): Quiz | null; listQuizzes(db, opts?: { includeArchived?: boolean }): Quiz[]   // только отдельные (course_id null)
  setQuizStatus(db, id, status, nextRunAt: string | null): Quiz | null; setQuizNextRunAt(db, id, iso | null): void
  listDueQuizzes(db, nowIso): Quiz[]     // published, course_id null, schedule not null, next_run_at <= now
  replaceQuestions(db, quizId, questions: QuestionInput[]): void; listQuestions(db, quizId): Question[]
  ```
- `learningAssignments.ts`:
  ```ts
  type CourseAssignment = { id; course_id; employee_id; assigned_at; due_at; current_lesson; status: 'in_progress' | 'completed' | 'overdue'; completed_at; reminder_sent_at }
  type CourseAssignmentRow = CourseAssignment & { title: string; lesson_count: number; employee_name: string }
  createCourseAssignment(db, i: { course_id; employee_id; assigned_at; due_at }): CourseAssignment | null   // null при дубликате
  getCourseAssignment(db, id): CourseAssignment | null; getCourseAssignmentRow(db, id): CourseAssignmentRow | null
  listEmployeeCourseAssignments(db, employeeId): CourseAssignmentRow[]
  listCourseAssignments(db, f: { course_id?; employee_id?; status? }): CourseAssignmentRow[]
  advanceLesson(db, id, fromLesson: number): boolean            // update where current_lesson = fromLesson
  completeCourseAssignment(db, id, nowIso): void                 // status completed, completed_at
  hasCourseAssignment(db, courseId, employeeId): boolean
  listCourseReminderCandidates(db, nowIso): CourseAssignment[]  // in_progress, reminder_sent_at null, due_at > now
  markCourseReminderSent(db, id, nowIso): void
  listCourseOverdueCandidates(db, nowIso): CourseAssignment[]   // in_progress, due_at < now
  setCourseAssignmentStatus(db, id, status): void

  type QuizAssignment = { id; quiz_id; employee_id; course_assignment_id: number | null; slot_at; assigned_at; due_at; status: 'pending' | 'passed' | 'overdue'; passed_at; reminder_sent_at }
  type QuizAssignmentRow = QuizAssignment & { title: string; employee_name: string; open_attempt_id: number | null; course_id: number | null }
  createQuizAssignment(db, i: { quiz_id; employee_id; course_assignment_id; slot_at; assigned_at; due_at }): QuizAssignment | null
  getQuizAssignment(db, id): QuizAssignment | null; getQuizAssignmentRow(db, id): QuizAssignmentRow | null
  listEmployeeQuizAssignments(db, employeeId): QuizAssignmentRow[]           // pending|overdue
  listQuizAssignments(db, f: { quiz_id?; employee_id?; status? }): QuizAssignmentRow[]
  markQuizPassed(db, id, nowIso): void
  listQuizReminderCandidates(db, nowIso): QuizAssignment[]; markQuizReminderSent(db, id, nowIso): void
  listQuizOverdueCandidates(db, nowIso): QuizAssignment[]; setQuizAssignmentStatus(db, id, status): void

  type QuizAttempt = { id; assignment_id; started_at; finished_at: string | null; current_question: number; answers: number[]; score: number | null; passed: boolean | null }
  getOpenAttempt(db, assignmentId): QuizAttempt | null
  createAttempt(db, assignmentId, nowIso): QuizAttempt          // бросает Error, если открытая уже есть
  getAttempt(db, id): QuizAttempt | null
  recordAnswer(db, attemptId, questionPosition, optionIndex): boolean   // только если current_question === questionPosition и попытка открыта; добавляет ответ, current_question + 1
  finishAttempt(db, id, score, passed: boolean, nowIso): void
  listAttempts(db, assignmentId): QuizAttempt[]
  ```
- `score.ts`: `scoreAnswers(answers: number[], questions: Question[]): { correct: number; total: number; score: number }`, `isPassed(score: number, passScore: number): boolean`.
- `server/test/learning.ts`: `seedCourse(db, positionIds, over?: Partial<CourseInput>): { course: Course; quiz: Quiz }` создаёт курс «Эспрессо по стандарту» с 3 уроками (второй с медиа: картинка `lessons/test.jpg` и видео `https://youtu.be/x`) и итоговым тестом из 2 вопросов (правильные индексы 1 и 0); `seedQuiz(db, positionIds, over?: Partial<QuizInput>): Quiz` создаёт отдельный тест «Меню недели» с 2 вопросами и расписанием пн 10:00, срок 480 минут.

- [ ] **Step 1: Миграция**

Добавить в `migrations`:
```ts
  {
    name: '003_learning',
    sql: `
      alter table employees add column linked_at text;
      alter table employees add column position_changed_at text;
      update employees set linked_at = case when telegram_id is not null then created_at else null end,
                           position_changed_at = created_at;

      create table courses (
        id integer primary key autoincrement,
        title text not null,
        description text not null default '',
        due_days integer not null,
        pass_score integer not null default 80,
        status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
        published_at text,
        assign_existing integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      create table course_positions (
        course_id integer not null references courses(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (course_id, position_id)
      );
      create table lessons (
        id integer primary key autoincrement,
        course_id integer not null references courses(id) on delete cascade,
        position integer not null,
        title text not null,
        body text not null default '',
        media text not null default '[]',
        unique (course_id, position)
      );
      create table quizzes (
        id integer primary key autoincrement,
        title text not null,
        course_id integer references courses(id) on delete cascade,
        pass_score integer not null default 80,
        schedule text,
        deadline_minutes integer,
        status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
        next_run_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      create unique index quizzes_course on quizzes(course_id) where course_id is not null;
      create table quiz_positions (
        quiz_id integer not null references quizzes(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (quiz_id, position_id)
      );
      create table questions (
        id integer primary key autoincrement,
        quiz_id integer not null references quizzes(id) on delete cascade,
        position integer not null,
        text text not null,
        options text not null,
        correct_index integer not null,
        unique (quiz_id, position)
      );
      create table course_assignments (
        id integer primary key autoincrement,
        course_id integer not null references courses(id),
        employee_id integer not null references employees(id),
        assigned_at text not null,
        due_at text not null,
        current_lesson integer not null default 1,
        status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'overdue')),
        completed_at text,
        reminder_sent_at text,
        unique (course_id, employee_id)
      );
      create table quiz_assignments (
        id integer primary key autoincrement,
        quiz_id integer not null references quizzes(id),
        employee_id integer not null references employees(id),
        course_assignment_id integer references course_assignments(id),
        slot_at text not null,
        assigned_at text not null,
        due_at text not null,
        status text not null default 'pending' check (status in ('pending', 'passed', 'overdue')),
        passed_at text,
        reminder_sent_at text,
        unique (quiz_id, employee_id, slot_at)
      );
      create table quiz_attempts (
        id integer primary key autoincrement,
        assignment_id integer not null references quiz_assignments(id),
        started_at text not null,
        finished_at text,
        current_question integer not null default 1,
        answers text not null default '[]',
        score integer,
        passed integer
      );
      create index quiz_attempts_open on quiz_attempts(assignment_id) where finished_at is null;
    `,
  },
```

`server/db/employees.ts`: в `Employee` добавить `linked_at: string | null` и `position_changed_at: string`; `columns` += `, linked_at, position_changed_at`; `createEmployee` вставляет `position_changed_at` тем же выражением, что и `created_at`: `insert into employees (full_name, phone, position_id, position_changed_at) values (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` (внутри одного statement SQLite даёт одинаковое `'now'`, поэтому значения совпадут); `linkTelegram`: `update employees set telegram_id = ?, status = 'active', linked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ?`; `updateEmployee`: если `patch.position_id !== undefined && patch.position_id !== current.position_id`, выполнять `update ... , position_changed_at = strftime(...)`, иначе прежний запрос. В `server/db/repos.test.ts` добавить:
```ts
  it('tracks linking and position change moments', () => {
    const p1 = createPosition(db, 'Официант')
    const p2 = createPosition(db, 'Бармен')
    const e = createEmployee(db, { full_name: 'Иван', phone: '+79990000001', position_id: p1.id })
    expect(e.linked_at).toBeNull()
    expect(e.position_changed_at).toBe(e.created_at)
    const linked = linkTelegram(db, e.id, 5)!
    expect(linked.linked_at).not.toBeNull()
    const same = updateEmployee(db, e.id, { full_name: 'Пётр' })!
    expect(same.position_changed_at).toBe(e.position_changed_at)
    db.prepare("update employees set position_changed_at = '2000-01-01T00:00:00.000Z' where id = ?").run(e.id)
    const moved = updateEmployee(db, e.id, { position_id: p2.id })!
    expect(moved.position_changed_at).not.toBe('2000-01-01T00:00:00.000Z')
    expect(moved.position_changed_at > '2026-01-01').toBe(true)
  })
```

Run: `npx vitest run server/db/connect.test.ts server/db/repos.test.ts` → все passed (существующие тесты сотрудников обновить, если они сравнивают объект сотрудника через `toEqual` с фиксированным набором полей — `toMatchObject` уже используется).

- [ ] **Step 2: Тест подсчёта балла**

`server/learning/score.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { Question } from '../db/quizzes.js'
import { isPassed, scoreAnswers } from './score.js'

const q = (position: number, correct: number): Question => ({ id: position, quiz_id: 1, position, text: 'q', options: ['a', 'b', 'c'], correct_index: correct })

describe('scoreAnswers', () => {
  it('counts correct answers by question order and rounds the percentage', () => {
    const questions = [q(1, 1), q(2, 0), q(3, 2)]
    expect(scoreAnswers([1, 0, 2], questions)).toEqual({ correct: 3, total: 3, score: 100 })
    expect(scoreAnswers([1, 1, 1], questions)).toEqual({ correct: 1, total: 3, score: 33 })
    expect(scoreAnswers([0, 0, 0], questions)).toEqual({ correct: 1, total: 3, score: 33 })
    expect(scoreAnswers([], questions)).toEqual({ correct: 0, total: 3, score: 0 })
  })
  it('isPassed compares with the pass score inclusively', () => {
    expect(isPassed(80, 80)).toBe(true)
    expect(isPassed(79, 80)).toBe(false)
  })
})
```

`server/learning/score.ts`:
```ts
import type { Question } from '../db/quizzes.js'

export function scoreAnswers(answers: number[], questions: Question[]): { correct: number; total: number; score: number } {
  const sorted = [...questions].sort((a, b) => a.position - b.position)
  const correct = sorted.filter((qu, i) => answers[i] === qu.correct_index).length
  const total = sorted.length
  return { correct, total, score: total === 0 ? 0 : Math.round((correct / total) * 100) }
}

export const isPassed = (score: number, passScore: number): boolean => score >= passScore
```

Run: `npx vitest run server/learning/score.test.ts` → 2 passed.

- [ ] **Step 3: Тесты репозиториев обучения**

`server/db/learning.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { getCourse, getLesson, listCourses, listLessons, listPublishedCourses, publishCourse, setCourseStatus, updateCourse } from './courses.js'
import { getCourseQuiz, listDueQuizzes, listQuestions, listQuizzes, replaceQuestions, setQuizStatus, updateQuiz } from './quizzes.js'
import {
  advanceLesson, completeCourseAssignment, createAttempt, createCourseAssignment, createQuizAssignment, finishAttempt,
  getAttempt, getCourseAssignment, getOpenAttempt, hasCourseAssignment, listAttempts, listCourseAssignments,
  listCourseOverdueCandidates, listCourseReminderCandidates, listEmployeeCourseAssignments, listEmployeeQuizAssignments,
  listQuizAssignments, listQuizOverdueCandidates, listQuizReminderCandidates, markQuizPassed, recordAnswer,
} from './learningAssignments.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('courses and lessons', () => {
  it('creates a course with lessons and a course quiz, publishes it', () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    expect(course).toMatchObject({ status: 'draft', lesson_count: 3, position_ids: [seed.positions.barista.id], pass_score: 80 })
    expect(listLessons(db, course.id).map((l) => l.position)).toEqual([1, 2, 3])
    expect(getLesson(db, course.id, 2)?.media).toEqual([{ kind: 'image', path: 'lessons/test.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }])
    expect(getCourseQuiz(db, course.id)?.id).toBe(quiz.id)
    expect(quiz.question_count).toBe(2)
    expect(listPublishedCourses(db)).toEqual([])
    const published = publishCourse(db, course.id, true, NOW)!
    expect(published).toMatchObject({ status: 'published', published_at: NOW, assign_existing: true })
    expect(listPublishedCourses(db)).toHaveLength(1)
    setCourseStatus(db, course.id, 'archived')
    expect(listCourses(db)).toEqual([])
    expect(listCourses(db, { includeArchived: true })).toHaveLength(1)
  })

  it('updates course fields, positions, lessons and questions', () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    const u = updateCourse(db, course.id, { title: 'Эспрессо', description: '', due_days: 3, pass_score: 90, position_ids: [seed.positions.cook.id] })!
    expect(u).toMatchObject({ title: 'Эспрессо', due_days: 3, pass_score: 90, position_ids: [seed.positions.cook.id] })
    replaceQuestions(db, quiz.id, [{ text: 'Один?', options: ['да', 'нет'], correct_index: 0 }])
    expect(listQuestions(db, quiz.id)).toHaveLength(1)
    expect(getCourse(db, 999)).toBeNull()
  })
})

describe('standalone quizzes', () => {
  it('lists standalone quizzes only and finds due ones', () => {
    seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id, seed.positions.cook.id])
    expect(listQuizzes(db).map((q) => q.id)).toEqual([quiz.id])
    expect(quiz.schedule).toEqual({ kind: 'weekly', days: [1], times: ['10:00'] })
    expect(listDueQuizzes(db, NOW)).toEqual([])
    setQuizStatus(db, quiz.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(listDueQuizzes(db, NOW).map((q) => q.id)).toEqual([quiz.id])
    updateQuiz(db, quiz.id, { title: 'Меню', course_id: null, pass_score: 70, schedule: null, deadline_minutes: 60, position_ids: [] }, null)
    expect(listDueQuizzes(db, NOW)).toEqual([])
  })
})

describe('course assignments', () => {
  it('assigns once, advances lessons, completes', () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const a = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    expect(a).toMatchObject({ current_lesson: 1, status: 'in_progress' })
    expect(createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: NOW })).toBeNull()
    expect(hasCourseAssignment(db, course.id, seed.employees.ivan.id)).toBe(true)
    expect(listEmployeeCourseAssignments(db, seed.employees.ivan.id)[0]).toMatchObject({ title: 'Эспрессо по стандарту', lesson_count: 3, employee_name: 'Иван Петров' })
    expect(advanceLesson(db, a.id, 1)).toBe(true)
    expect(advanceLesson(db, a.id, 1)).toBe(false)
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    completeCourseAssignment(db, a.id, NOW)
    expect(getCourseAssignment(db, a.id)).toMatchObject({ status: 'completed', completed_at: NOW })
    expect(listCourseAssignments(db, { status: 'completed' })).toHaveLength(1)
  })

  it('reminder and overdue candidates', () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const soon = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-08T10:00:00.000Z' })!
    const late = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-06T10:00:00.000Z' })!
    expect(listCourseReminderCandidates(db, NOW).map((x) => x.id)).toEqual([soon.id])
    expect(listCourseOverdueCandidates(db, NOW).map((x) => x.id)).toEqual([late.id])
  })
})

describe('quiz assignments and attempts', () => {
  it('runs an attempt question by question and finishes it', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const a = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
    expect(createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: NOW })).toBeNull()
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)[0]).toMatchObject({ title: 'Меню недели', open_attempt_id: null })
    expect(getOpenAttempt(db, a.id)).toBeNull()
    const attempt = createAttempt(db, a.id, NOW)
    expect(() => createAttempt(db, a.id, NOW)).toThrow(/open attempt/)
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)[0]?.open_attempt_id).toBe(attempt.id)
    expect(recordAnswer(db, attempt.id, 2, 0)).toBe(false)
    expect(recordAnswer(db, attempt.id, 1, 1)).toBe(true)
    expect(recordAnswer(db, attempt.id, 1, 0)).toBe(false)
    expect(getAttempt(db, attempt.id)).toMatchObject({ current_question: 2, answers: [1] })
    expect(recordAnswer(db, attempt.id, 2, 0)).toBe(true)
    finishAttempt(db, attempt.id, 100, true, NOW)
    expect(getAttempt(db, attempt.id)).toMatchObject({ finished_at: NOW, score: 100, passed: true })
    expect(recordAnswer(db, attempt.id, 3, 0)).toBe(false)
    expect(getOpenAttempt(db, a.id)).toBeNull()
    markQuizPassed(db, a.id, NOW)
    expect(listQuizAssignments(db, { status: 'passed' })).toHaveLength(1)
    expect(listAttempts(db, a.id)).toHaveLength(1)
    expect(listEmployeeQuizAssignments(db, seed.employees.ivan.id)).toEqual([])
  })

  it('reminder and overdue candidates', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const soon = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
    const late = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.anna.id, course_assignment_id: null, slot_at: '2026-09-06T10:00:00.000Z', assigned_at: '2026-09-06T10:00:00.000Z', due_at: '2026-09-06T18:00:00.000Z' })!
    expect(listQuizReminderCandidates(db, NOW).map((x) => x.id)).toEqual([soon.id])
    expect(listQuizOverdueCandidates(db, NOW).map((x) => x.id)).toEqual([late.id])
  })
})
```

Run: `npx vitest run server/db/learning.test.ts` → FAIL (модули не найдены).

- [ ] **Step 4: server/db/courses.ts**

```ts
import type { Db } from './connect.js'

export type CourseStatus = 'draft' | 'published' | 'archived'
export type Media = { kind: 'image'; path: string } | { kind: 'video'; url: string }
export type Lesson = { id: number; course_id: number; position: number; title: string; body: string; media: Media[] }
export type LessonInput = { title: string; body: string; media: Media[] }

export type Course = {
  id: number
  title: string
  description: string
  due_days: number
  pass_score: number
  status: CourseStatus
  published_at: string | null
  assign_existing: boolean
  created_at: string
  position_ids: number[]
  lesson_count: number
}
export type CourseInput = { title: string; description: string; due_days: number; pass_score: number; position_ids: number[] }

type Row = Omit<Course, 'assign_existing' | 'position_ids' | 'lesson_count'> & { assign_existing: number; lesson_count: number }
const cols = `c.id, c.title, c.description, c.due_days, c.pass_score, c.status, c.published_at, c.assign_existing, c.created_at,
  (select count(*) from lessons l where l.course_id = c.id) as lesson_count`

function hydrate(db: Db, r: Row): Course {
  const position_ids = (db.prepare('select position_id from course_positions where course_id = ? order by position_id').all(r.id) as { position_id: number }[]).map((x) => x.position_id)
  return { ...r, assign_existing: r.assign_existing === 1, position_ids }
}

function writePositions(db: Db, id: number, ids: number[]): void {
  db.prepare('delete from course_positions where course_id = ?').run(id)
  const ins = db.prepare('insert into course_positions (course_id, position_id) values (?, ?)')
  for (const p of ids) ins.run(id, p)
}

export function getCourse(db: Db, id: number): Course | null {
  const r = db.prepare(`select ${cols} from courses c where c.id = ?`).get(id) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function createCourse(db: Db, input: CourseInput): Course {
  return db.transaction(() => {
    const info = db
      .prepare('insert into courses (title, description, due_days, pass_score) values (?, ?, ?, ?)')
      .run(input.title, input.description, input.due_days, input.pass_score)
    const id = Number(info.lastInsertRowid)
    writePositions(db, id, input.position_ids)
    return getCourse(db, id)!
  })()
}

export function updateCourse(db: Db, id: number, input: CourseInput): Course | null {
  return db.transaction(() => {
    const info = db
      .prepare('update courses set title = ?, description = ?, due_days = ?, pass_score = ? where id = ?')
      .run(input.title, input.description, input.due_days, input.pass_score, id)
    if (info.changes === 0) return null
    writePositions(db, id, input.position_ids)
    return getCourse(db, id)
  })()
}

export function listCourses(db: Db, opts: { includeArchived?: boolean } = {}): Course[] {
  const where = opts.includeArchived ? '' : "where c.status != 'archived'"
  return (db.prepare(`select ${cols} from courses c ${where} order by c.title`).all() as Row[]).map((r) => hydrate(db, r))
}

export function listPublishedCourses(db: Db): Course[] {
  return (db.prepare(`select ${cols} from courses c where c.status = 'published' order by c.id`).all() as Row[]).map((r) => hydrate(db, r))
}

export function publishCourse(db: Db, id: number, assignExisting: boolean, nowIso: string): Course | null {
  const info = db
    .prepare("update courses set status = 'published', published_at = ?, assign_existing = ? where id = ?")
    .run(nowIso, assignExisting ? 1 : 0, id)
  return info.changes === 0 ? null : getCourse(db, id)
}

export function setCourseStatus(db: Db, id: number, status: CourseStatus): Course | null {
  const info = db.prepare('update courses set status = ? where id = ?').run(status, id)
  return info.changes === 0 ? null : getCourse(db, id)
}

type LessonRow = Omit<Lesson, 'media'> & { media: string }
const lessonCols = 'id, course_id, position, title, body, media'
const toLesson = (r: LessonRow): Lesson => ({ ...r, media: JSON.parse(r.media) as Media[] })

export function replaceLessons(db: Db, courseId: number, lessons: LessonInput[]): void {
  db.transaction(() => {
    db.prepare('delete from lessons where course_id = ?').run(courseId)
    const ins = db.prepare('insert into lessons (course_id, position, title, body, media) values (?, ?, ?, ?, ?)')
    lessons.forEach((l, i) => ins.run(courseId, i + 1, l.title, l.body, JSON.stringify(l.media)))
  })()
}

export function listLessons(db: Db, courseId: number): Lesson[] {
  return (db.prepare(`select ${lessonCols} from lessons where course_id = ? order by position`).all(courseId) as LessonRow[]).map(toLesson)
}

export function getLesson(db: Db, courseId: number, position: number): Lesson | null {
  const r = db.prepare(`select ${lessonCols} from lessons where course_id = ? and position = ?`).get(courseId, position) as LessonRow | undefined
  return r ? toLesson(r) : null
}
```

- [ ] **Step 5: server/db/quizzes.ts**

```ts
import type { Db } from './connect.js'
import type { Schedule } from '../tasks/schedule.js'

export type QuizStatus = 'draft' | 'published' | 'archived'
export type Question = { id: number; quiz_id: number; position: number; text: string; options: string[]; correct_index: number }
export type QuestionInput = { text: string; options: string[]; correct_index: number }

export type Quiz = {
  id: number
  title: string
  course_id: number | null
  pass_score: number
  schedule: Schedule | null
  deadline_minutes: number | null
  status: QuizStatus
  next_run_at: string | null
  created_at: string
  position_ids: number[]
  question_count: number
}
export type QuizInput = {
  title: string
  course_id: number | null
  pass_score: number
  schedule: Schedule | null
  deadline_minutes: number | null
  position_ids: number[]
}

type Row = Omit<Quiz, 'schedule' | 'position_ids'> & { schedule: string | null }
const cols = `q.id, q.title, q.course_id, q.pass_score, q.schedule, q.deadline_minutes, q.status, q.next_run_at, q.created_at,
  (select count(*) from questions x where x.quiz_id = q.id) as question_count`

function hydrate(db: Db, r: Row): Quiz {
  const position_ids = (db.prepare('select position_id from quiz_positions where quiz_id = ? order by position_id').all(r.id) as { position_id: number }[]).map((x) => x.position_id)
  return { ...r, schedule: r.schedule ? (JSON.parse(r.schedule) as Schedule) : null, position_ids }
}

function writePositions(db: Db, id: number, ids: number[]): void {
  db.prepare('delete from quiz_positions where quiz_id = ?').run(id)
  const ins = db.prepare('insert into quiz_positions (quiz_id, position_id) values (?, ?)')
  for (const p of ids) ins.run(id, p)
}

export function getQuiz(db: Db, id: number): Quiz | null {
  const r = db.prepare(`select ${cols} from quizzes q where q.id = ?`).get(id) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function getCourseQuiz(db: Db, courseId: number): Quiz | null {
  const r = db.prepare(`select ${cols} from quizzes q where q.course_id = ?`).get(courseId) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function createQuiz(db: Db, input: QuizInput, nextRunAt: string | null): Quiz {
  return db.transaction(() => {
    const info = db
      .prepare('insert into quizzes (title, course_id, pass_score, schedule, deadline_minutes, next_run_at) values (?, ?, ?, ?, ?, ?)')
      .run(input.title, input.course_id, input.pass_score, input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt)
    const id = Number(info.lastInsertRowid)
    writePositions(db, id, input.position_ids)
    return getQuiz(db, id)!
  })()
}

export function updateQuiz(db: Db, id: number, input: QuizInput, nextRunAt: string | null): Quiz | null {
  return db.transaction(() => {
    const info = db
      .prepare('update quizzes set title = ?, course_id = ?, pass_score = ?, schedule = ?, deadline_minutes = ?, next_run_at = ? where id = ?')
      .run(input.title, input.course_id, input.pass_score, input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt, id)
    if (info.changes === 0) return null
    writePositions(db, id, input.position_ids)
    return getQuiz(db, id)
  })()
}

export function listQuizzes(db: Db, opts: { includeArchived?: boolean } = {}): Quiz[] {
  const where = opts.includeArchived ? '' : "and q.status != 'archived'"
  return (db.prepare(`select ${cols} from quizzes q where q.course_id is null ${where} order by q.title`).all() as Row[]).map((r) => hydrate(db, r))
}

export function setQuizStatus(db: Db, id: number, status: QuizStatus, nextRunAt: string | null): Quiz | null {
  const info = db.prepare('update quizzes set status = ?, next_run_at = ? where id = ?').run(status, nextRunAt, id)
  return info.changes === 0 ? null : getQuiz(db, id)
}

export function setQuizNextRunAt(db: Db, id: number, iso: string | null): void {
  db.prepare('update quizzes set next_run_at = ? where id = ?').run(iso, id)
}

export function listDueQuizzes(db: Db, nowIso: string): Quiz[] {
  return (
    db
      .prepare(`select ${cols} from quizzes q where q.status = 'published' and q.course_id is null and q.schedule is not null and q.next_run_at is not null and q.next_run_at <= ? order by q.next_run_at`)
      .all(nowIso) as Row[]
  ).map((r) => hydrate(db, r))
}

type QuestionRow = Omit<Question, 'options'> & { options: string }
const toQuestion = (r: QuestionRow): Question => ({ ...r, options: JSON.parse(r.options) as string[] })

export function replaceQuestions(db: Db, quizId: number, questions: QuestionInput[]): void {
  db.transaction(() => {
    db.prepare('delete from questions where quiz_id = ?').run(quizId)
    const ins = db.prepare('insert into questions (quiz_id, position, text, options, correct_index) values (?, ?, ?, ?, ?)')
    questions.forEach((q, i) => ins.run(quizId, i + 1, q.text, JSON.stringify(q.options), q.correct_index))
  })()
}

export function listQuestions(db: Db, quizId: number): Question[] {
  return (db.prepare('select id, quiz_id, position, text, options, correct_index from questions where quiz_id = ? order by position').all(quizId) as QuestionRow[]).map(toQuestion)
}
```

- [ ] **Step 6: server/db/learningAssignments.ts**

```ts
import type { Db } from './connect.js'

export type CourseAssignmentStatus = 'in_progress' | 'completed' | 'overdue'
export type CourseAssignment = {
  id: number
  course_id: number
  employee_id: number
  assigned_at: string
  due_at: string
  current_lesson: number
  status: CourseAssignmentStatus
  completed_at: string | null
  reminder_sent_at: string | null
}
export type CourseAssignmentRow = CourseAssignment & { title: string; lesson_count: number; employee_name: string }

const caCols = 'a.id, a.course_id, a.employee_id, a.assigned_at, a.due_at, a.current_lesson, a.status, a.completed_at, a.reminder_sent_at'
const caRow = `select ${caCols}, c.title, (select count(*) from lessons l where l.course_id = c.id) as lesson_count, e.full_name as employee_name
  from course_assignments a join courses c on c.id = a.course_id join employees e on e.id = a.employee_id`

function uniqueOrNull<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

export function createCourseAssignment(
  db: Db, i: { course_id: number; employee_id: number; assigned_at: string; due_at: string },
): CourseAssignment | null {
  return uniqueOrNull(() => {
    const info = db
      .prepare('insert into course_assignments (course_id, employee_id, assigned_at, due_at) values (?, ?, ?, ?)')
      .run(i.course_id, i.employee_id, i.assigned_at, i.due_at)
    return getCourseAssignment(db, Number(info.lastInsertRowid))!
  })
}

export function getCourseAssignment(db: Db, id: number): CourseAssignment | null {
  return (db.prepare(`select ${caCols} from course_assignments a where a.id = ?`).get(id) as CourseAssignment) ?? null
}

export function getCourseAssignmentRow(db: Db, id: number): CourseAssignmentRow | null {
  return (db.prepare(`${caRow} where a.id = ?`).get(id) as CourseAssignmentRow) ?? null
}

export function listEmployeeCourseAssignments(db: Db, employeeId: number): CourseAssignmentRow[] {
  return db.prepare(`${caRow} where a.employee_id = ? order by a.due_at`).all(employeeId) as CourseAssignmentRow[]
}

export function listCourseAssignments(db: Db, f: { course_id?: number; employee_id?: number; status?: CourseAssignmentStatus }): CourseAssignmentRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.course_id) { where.push('a.course_id = ?'); args.push(f.course_id) }
  if (f.employee_id) { where.push('a.employee_id = ?'); args.push(f.employee_id) }
  if (f.status) { where.push('a.status = ?'); args.push(f.status) }
  const sql = `${caRow} ${where.length ? 'where ' + where.join(' and ') : ''} order by a.assigned_at desc, a.id desc limit 500`
  return db.prepare(sql).all(...args) as CourseAssignmentRow[]
}

export function hasCourseAssignment(db: Db, courseId: number, employeeId: number): boolean {
  return db.prepare('select 1 from course_assignments where course_id = ? and employee_id = ?').get(courseId, employeeId) !== undefined
}

export function advanceLesson(db: Db, id: number, fromLesson: number): boolean {
  return db.prepare('update course_assignments set current_lesson = current_lesson + 1 where id = ? and current_lesson = ?').run(id, fromLesson).changes === 1
}

export function completeCourseAssignment(db: Db, id: number, nowIso: string): void {
  db.prepare("update course_assignments set status = 'completed', completed_at = ? where id = ?").run(nowIso, id)
}

export function setCourseAssignmentStatus(db: Db, id: number, status: CourseAssignmentStatus): void {
  db.prepare('update course_assignments set status = ? where id = ?').run(status, id)
}

export function listCourseReminderCandidates(db: Db, nowIso: string): CourseAssignment[] {
  return db.prepare(`select ${caCols} from course_assignments a where a.status = 'in_progress' and a.reminder_sent_at is null and a.due_at > ? order by a.due_at`).all(nowIso) as CourseAssignment[]
}

export function markCourseReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update course_assignments set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listCourseOverdueCandidates(db: Db, nowIso: string): CourseAssignment[] {
  return db.prepare(`select ${caCols} from course_assignments a where a.status = 'in_progress' and a.due_at < ? order by a.due_at`).all(nowIso) as CourseAssignment[]
}

export type QuizAssignmentStatus = 'pending' | 'passed' | 'overdue'
export type QuizAssignment = {
  id: number
  quiz_id: number
  employee_id: number
  course_assignment_id: number | null
  slot_at: string
  assigned_at: string
  due_at: string
  status: QuizAssignmentStatus
  passed_at: string | null
  reminder_sent_at: string | null
}
export type QuizAssignmentRow = QuizAssignment & { title: string; employee_name: string; open_attempt_id: number | null; course_id: number | null }

const qaCols = 'a.id, a.quiz_id, a.employee_id, a.course_assignment_id, a.slot_at, a.assigned_at, a.due_at, a.status, a.passed_at, a.reminder_sent_at'
const qaRow = `select ${qaCols}, q.title, q.course_id, e.full_name as employee_name,
  (select t.id from quiz_attempts t where t.assignment_id = a.id and t.finished_at is null limit 1) as open_attempt_id
  from quiz_assignments a join quizzes q on q.id = a.quiz_id join employees e on e.id = a.employee_id`

export function createQuizAssignment(
  db: Db,
  i: { quiz_id: number; employee_id: number; course_assignment_id: number | null; slot_at: string; assigned_at: string; due_at: string },
): QuizAssignment | null {
  return uniqueOrNull(() => {
    const info = db
      .prepare('insert into quiz_assignments (quiz_id, employee_id, course_assignment_id, slot_at, assigned_at, due_at) values (?, ?, ?, ?, ?, ?)')
      .run(i.quiz_id, i.employee_id, i.course_assignment_id, i.slot_at, i.assigned_at, i.due_at)
    return getQuizAssignment(db, Number(info.lastInsertRowid))!
  })
}

export function getQuizAssignment(db: Db, id: number): QuizAssignment | null {
  return (db.prepare(`select ${qaCols} from quiz_assignments a where a.id = ?`).get(id) as QuizAssignment) ?? null
}

export function getQuizAssignmentRow(db: Db, id: number): QuizAssignmentRow | null {
  return (db.prepare(`${qaRow} where a.id = ?`).get(id) as QuizAssignmentRow) ?? null
}

export function listEmployeeQuizAssignments(db: Db, employeeId: number): QuizAssignmentRow[] {
  return db.prepare(`${qaRow} where a.employee_id = ? and a.status in ('pending', 'overdue') order by a.due_at`).all(employeeId) as QuizAssignmentRow[]
}

export function listQuizAssignments(db: Db, f: { quiz_id?: number; employee_id?: number; status?: QuizAssignmentStatus }): QuizAssignmentRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.quiz_id) { where.push('a.quiz_id = ?'); args.push(f.quiz_id) }
  if (f.employee_id) { where.push('a.employee_id = ?'); args.push(f.employee_id) }
  if (f.status) { where.push('a.status = ?'); args.push(f.status) }
  const sql = `${qaRow} ${where.length ? 'where ' + where.join(' and ') : ''} order by a.assigned_at desc, a.id desc limit 500`
  return db.prepare(sql).all(...args) as QuizAssignmentRow[]
}

export function markQuizPassed(db: Db, id: number, nowIso: string): void {
  db.prepare("update quiz_assignments set status = 'passed', passed_at = ? where id = ?").run(nowIso, id)
}

export function setQuizAssignmentStatus(db: Db, id: number, status: QuizAssignmentStatus): void {
  db.prepare('update quiz_assignments set status = ? where id = ?').run(status, id)
}

export function listQuizReminderCandidates(db: Db, nowIso: string): QuizAssignment[] {
  return db.prepare(`select ${qaCols} from quiz_assignments a where a.status = 'pending' and a.reminder_sent_at is null and a.due_at > ? order by a.due_at`).all(nowIso) as QuizAssignment[]
}

export function markQuizReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update quiz_assignments set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listQuizOverdueCandidates(db: Db, nowIso: string): QuizAssignment[] {
  return db.prepare(`select ${qaCols} from quiz_assignments a where a.status = 'pending' and a.due_at < ? order by a.due_at`).all(nowIso) as QuizAssignment[]
}

export type QuizAttempt = {
  id: number
  assignment_id: number
  started_at: string
  finished_at: string | null
  current_question: number
  answers: number[]
  score: number | null
  passed: boolean | null
}
type AttemptRow = Omit<QuizAttempt, 'answers' | 'passed'> & { answers: string; passed: number | null }
const atCols = 'id, assignment_id, started_at, finished_at, current_question, answers, score, passed'
const toAttempt = (r: AttemptRow): QuizAttempt => ({ ...r, answers: JSON.parse(r.answers) as number[], passed: r.passed === null ? null : r.passed === 1 })

export function getOpenAttempt(db: Db, assignmentId: number): QuizAttempt | null {
  const r = db.prepare(`select ${atCols} from quiz_attempts where assignment_id = ? and finished_at is null`).get(assignmentId) as AttemptRow | undefined
  return r ? toAttempt(r) : null
}

export function createAttempt(db: Db, assignmentId: number, nowIso: string): QuizAttempt {
  if (getOpenAttempt(db, assignmentId)) throw new Error('assignment already has an open attempt')
  const info = db.prepare('insert into quiz_attempts (assignment_id, started_at) values (?, ?)').run(assignmentId, nowIso)
  return getAttempt(db, Number(info.lastInsertRowid))!
}

export function getAttempt(db: Db, id: number): QuizAttempt | null {
  const r = db.prepare(`select ${atCols} from quiz_attempts where id = ?`).get(id) as AttemptRow | undefined
  return r ? toAttempt(r) : null
}

export function recordAnswer(db: Db, attemptId: number, questionPosition: number, optionIndex: number): boolean {
  return db.transaction(() => {
    const a = getAttempt(db, attemptId)
    if (!a || a.finished_at || a.current_question !== questionPosition) return false
    const answers = [...a.answers, optionIndex]
    db.prepare('update quiz_attempts set answers = ?, current_question = current_question + 1 where id = ?').run(JSON.stringify(answers), attemptId)
    return true
  })()
}

export function finishAttempt(db: Db, id: number, score: number, passed: boolean, nowIso: string): void {
  db.prepare('update quiz_attempts set finished_at = ?, score = ?, passed = ? where id = ?').run(nowIso, score, passed ? 1 : 0, id)
}

export function listAttempts(db: Db, assignmentId: number): QuizAttempt[] {
  return (db.prepare(`select ${atCols} from quiz_attempts where assignment_id = ? order by id`).all(assignmentId) as AttemptRow[]).map(toAttempt)
}
```

- [ ] **Step 7: server/test/learning.ts**

```ts
import type { Db } from '../db/connect.js'
import { createCourse, replaceLessons, type Course, type CourseInput } from '../db/courses.js'
import { createQuiz, replaceQuestions, type Quiz, type QuizInput } from '../db/quizzes.js'
import { nextRun } from '../tasks/schedule.js'

export function seedCourse(db: Db, positionIds: number[], over: Partial<CourseInput> = {}): { course: Course; quiz: Quiz } {
  const created = createCourse(db, {
    title: 'Эспрессо по стандарту', description: 'Базовый курс бариста', due_days: 7, pass_score: 80, position_ids: positionIds, ...over,
  })
  replaceLessons(db, created.id, [
    { title: 'Помол и дозировка', body: 'Помол под эспрессо: 18 г на двойной холдер.', media: [] },
    { title: 'Экстракция', body: 'Экстракция 25–30 секунд.', media: [{ kind: 'image', path: 'lessons/test.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }] },
    { title: 'Молоко', body: 'Молоко до 60–65 °C.', media: [] },
  ])
  const quiz = createQuiz(db, { title: 'Итоговый тест: Эспрессо', course_id: created.id, pass_score: 80, schedule: null, deadline_minutes: null, position_ids: [] }, null)
  replaceQuestions(db, quiz.id, [
    { text: 'Сколько секунд длится экстракция?', options: ['10–15', '25–30', '50–60'], correct_index: 1 },
    { text: 'Температура молока для капучино?', options: ['60–65 °C', '80–90 °C'], correct_index: 0 },
  ])
  const course = { ...created, lesson_count: 3 }
  return { course, quiz: { ...quiz, question_count: 2 } }
}

export function seedQuiz(db: Db, positionIds: number[], over: Partial<QuizInput> = {}): Quiz {
  const input: QuizInput = {
    title: 'Меню недели', course_id: null, pass_score: 80,
    schedule: { kind: 'weekly', days: [1], times: ['10:00'] }, deadline_minutes: 480, position_ids: positionIds, ...over,
  }
  const quiz = createQuiz(db, input, input.schedule ? nextRun(input.schedule, new Date('2026-09-07T00:00:00.000Z'), 'Europe/Moscow').toISOString() : null)
  replaceQuestions(db, quiz.id, [
    { text: 'Что в сезонном меню?', options: ['Тыквенный латте', 'Окрошка'], correct_index: 0 },
    { text: 'Цена капучино?', options: ['250', '300', '350'], correct_index: 1 },
  ])
  return { ...quiz, question_count: 2 }
}
```

Run: `npx vitest run server/db/learning.test.ts` → все passed.

- [ ] **Step 8: Всё зелёное, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/db server/learning server/test/learning.ts
git commit -m "feat: learning migration, repositories and score calculation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Сервис назначений и шаги планировщика

**Files:**
- Modify: `server/bot/callbacks.ts`, `server/bot/keyboards.ts`, `server/scheduler/tick.ts`
- Create: `server/learning/assign.ts`, `server/learning/assign.test.ts`, `server/scheduler/learning.ts`, `server/scheduler/learning.test.ts`

**Interfaces:**
- `callbacks.ts` += `CB.courseContinue(assignmentId)` → `course:continue:<id>`, `CB.courseNext(assignmentId, lesson)` → `course:next:<id>:<lesson>`, `CB.quizStart(assignmentId)` → `quiz:start:<id>`, `CB.quizAnswer(attemptId, question, option)` → `quiz:answer:<a>:<q>:<o>`; `CB_RE` с регулярками `^course:continue:(\d+)$`, `^course:next:(\d+):(\d+)$`, `^quiz:start:(\d+)$`, `^quiz:answer:(\d+):(\d+):(\d+)$`.
- `keyboards.ts` += `continueCourseKeyboard(assignmentId)` («Продолжить»), `nextLessonKeyboard(assignmentId, lesson)` («Прочитал, дальше»), `startQuizKeyboard(assignmentId, label = 'Начать')`, `answersKeyboard(attemptId, question, options: string[])` (по кнопке на вариант, каждая в своей строке).
- `assign.ts`:
  ```ts
  type LearningDeps = { db: Db; notifier: Notifier; tz: string }
  assignCourseToEmployee(deps, course: Course, employee: Employee, now: Date): Promise<CourseAssignment | null>   // null если уже назначен; уведомление «Новый курс»
  eligibleForCourse(db, course: Course, onlyNew: boolean): Employee[]   // активные сотрудники должностей курса без назначения; onlyNew → max(linked_at, position_changed_at) > published_at
  assignCourse(deps, course: Course, now: Date, onlyNew: boolean): Promise<number>   // число назначений
  issueQuiz(deps, quiz: Quiz, slotAt: Date, now: Date): Promise<number>   // назначения активным сотрудникам должностей теста, уведомление «Новый тест»
  courseDueAt(assignedAt: Date, dueDays: number): string
  ```
- `scheduler/learning.ts`: `assignCourses(deps, now): Promise<number>`, `issueDueQuizzes(deps, now): Promise<number>`, `learningReminders(deps, now): Promise<number>`, `learningOverdue(deps, now): Promise<number>`; `SchedulerDeps` не меняется; шаги добавляются в `tick.ts` после `retryReviews`.
- Тексты: «Новый курс: «<название>». Срок: до <дата время>», «Новый тест: «<название>». Срок: до <…>», «Напоминание: курс «…» нужно пройти до …», «Напоминание: тест «…» нужно пройти до …», «Курс «…» просрочен», «Тест «…» просрочен» (сотруднику); владельцу «<сотрудник> просрочил курс/тест «…»».
- Правила напоминаний: курс за 24 часа, если `due_at - assigned_at > 48 ч`, иначе за половину; тест за половину `due_at - assigned_at`.

- [ ] **Step 1: callbacks и клавиатуры**

`server/bot/callbacks.ts`, добавить в `CB`:
```ts
  courseContinue: (assignmentId: number) => `course:continue:${assignmentId}`,
  courseNext: (assignmentId: number, lesson: number) => `course:next:${assignmentId}:${lesson}`,
  quizStart: (assignmentId: number) => `quiz:start:${assignmentId}`,
  quizAnswer: (attemptId: number, question: number, option: number) => `quiz:answer:${attemptId}:${question}:${option}`,
```
и в `CB_RE`:
```ts
  courseContinue: /^course:continue:(\d+)$/,
  courseNext: /^course:next:(\d+):(\d+)$/,
  quizStart: /^quiz:start:(\d+)$/,
  quizAnswer: /^quiz:answer:(\d+):(\d+):(\d+)$/,
```

`server/bot/keyboards.ts`, добавить:
```ts
export const continueCourseKeyboard = (assignmentId: number) => new InlineKeyboard().text('Продолжить', CB.courseContinue(assignmentId))
export const nextLessonKeyboard = (assignmentId: number, lesson: number) => new InlineKeyboard().text('Прочитал, дальше', CB.courseNext(assignmentId, lesson))
export const startQuizKeyboard = (assignmentId: number, label = 'Начать') => new InlineKeyboard().text(label, CB.quizStart(assignmentId))
export function answersKeyboard(attemptId: number, question: number, options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, i) => kb.text(o, CB.quizAnswer(attemptId, question, i)).row())
  return kb
}
```

- [ ] **Step 2: Тесты сервиса назначений**

`server/learning/assign.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { linkTelegram, updateEmployee } from '../db/employees.js'
import { publishCourse } from '../db/courses.js'
import { listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { assignCourse, courseDueAt, eligibleForCourse, issueQuiz } from './assign.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
const deps = () => ({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' })

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  log = []
})

describe('assignCourse', () => {
  it('assigns to all active employees of the positions when onlyNew is false', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const published = publishCourse(db, course.id, true, NOW.toISOString())!
    expect(await assignCourse(deps(), published, NOW, false)).toBe(2)
    expect(listCourseAssignments(db, {}).map((a) => a.employee_name).sort()).toEqual(['Анна Смирнова', 'Иван Петров'])
    expect(listCourseAssignments(db, {})[0]?.due_at).toBe(courseDueAt(NOW, 7))
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toContain('Новый курс')
    expect(await assignCourse(deps(), published, NOW, false)).toBe(0)
  })

  it('onlyNew skips employees linked before publication and picks up newcomers and position changes', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    // Иван и Анна привязались до публикации (linked_at = now в фикстуре, публикация позже)
    const published = publishCourse(db, course.id, false, new Date(Date.now() + 60_000).toISOString())!
    expect(eligibleForCourse(db, published, true)).toEqual([])
    // Пётр переводится в бариста после публикации
    db.prepare("update employees set position_changed_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.petr.id)
    updateEmployee(db, seed.employees.petr.id, { position_id: seed.positions.barista.id })
    db.prepare("update employees set position_changed_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.petr.id)
    // Ольга становится бариста и привязывается позже публикации
    updateEmployee(db, seed.employees.olga.id, { position_id: seed.positions.barista.id })
    linkTelegram(db, seed.employees.olga.id, 503)
    db.prepare("update employees set linked_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.olga.id)
    expect(eligibleForCourse(db, published, true).map((e) => e.full_name).sort()).toEqual(['Ольга Новикова', 'Пётр Кузнецов'])
    expect(await assignCourse(deps(), published, NOW, true)).toBe(2)
  })
})

describe('issueQuiz', () => {
  it('creates one assignment per employee of the quiz positions with the deadline', async () => {
    const quiz = seedQuiz(db, [seed.positions.cook.id])
    const slot = new Date('2026-09-07T07:00:00.000Z')
    expect(await issueQuiz(deps(), quiz, slot, NOW)).toBe(1)
    const rows = listQuizAssignments(db, {})
    expect(rows[0]).toMatchObject({ employee_name: 'Пётр Кузнецов', slot_at: slot.toISOString(), due_at: '2026-09-07T15:00:00.000Z', status: 'pending' })
    expect(log[0]).toMatchObject({ to: 502, text: expect.stringContaining('Новый тест') })
    expect(await issueQuiz(deps(), quiz, slot, NOW)).toBe(0)
  })
})
```

Run: `npx vitest run server/learning/assign.test.ts` → FAIL (модуль не найден).

- [ ] **Step 3: server/learning/assign.ts**

```ts
import type { Db } from '../db/connect.js'
import type { Employee } from '../db/employees.js'
import type { Course } from '../db/courses.js'
import type { Quiz } from '../db/quizzes.js'
import { createCourseAssignment, createQuizAssignment, type CourseAssignment } from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import type { Notifier } from '../notify.js'
import { continueCourseKeyboard, startQuizKeyboard } from '../bot/keyboards.js'

export type LearningDeps = { db: Db; notifier: Notifier; tz: string }

const employeeCols = 'e.id, e.full_name, e.phone, e.position_id, e.telegram_id, e.status, e.created_at, e.linked_at, e.position_changed_at'

export function courseDueAt(assignedAt: Date, dueDays: number): string {
  return new Date(assignedAt.getTime() + dueDays * 24 * 60 * 60_000).toISOString()
}

export function eligibleForCourse(db: Db, course: Course, onlyNew: boolean): Employee[] {
  const newcomers = onlyNew
    ? "and max(coalesce(e.linked_at, ''), e.position_changed_at) > ?"
    : ''
  const args: unknown[] = [course.id, course.id]
  if (onlyNew) args.push(course.published_at ?? '')
  return db
    .prepare(
      `select ${employeeCols} from employees e
       join course_positions cp on cp.position_id = e.position_id and cp.course_id = ?
       where e.status = 'active'
         and not exists (select 1 from course_assignments a where a.course_id = ? and a.employee_id = e.id)
         ${newcomers}
       order by e.full_name`,
    )
    .all(...args) as Employee[]
}

export async function assignCourseToEmployee(deps: LearningDeps, course: Course, employee: Employee, now: Date): Promise<CourseAssignment | null> {
  const a = createCourseAssignment(deps.db, {
    course_id: course.id, employee_id: employee.id, assigned_at: now.toISOString(), due_at: courseDueAt(now, course.due_days),
  })
  if (!a) return null
  if (employee.telegram_id !== null) {
    await deps.notifier.toEmployee(
      employee.telegram_id,
      `Новый курс: «${course.title}». Срок: до ${formatLocal(new Date(a.due_at), deps.tz, now)}`,
      { keyboard: continueCourseKeyboard(a.id) },
    )
  }
  return a
}

export async function assignCourse(deps: LearningDeps, course: Course, now: Date, onlyNew: boolean): Promise<number> {
  let count = 0
  for (const e of eligibleForCourse(deps.db, course, onlyNew)) {
    if (await assignCourseToEmployee(deps, course, e, now)) count++
  }
  return count
}

export async function issueQuiz(deps: LearningDeps, quiz: Quiz, slotAt: Date, now: Date): Promise<number> {
  const employees = deps.db
    .prepare(
      `select ${employeeCols} from employees e join quiz_positions qp on qp.position_id = e.position_id and qp.quiz_id = ?
       where e.status = 'active' order by e.full_name`,
    )
    .all(quiz.id) as Employee[]
  const due = new Date(slotAt.getTime() + (quiz.deadline_minutes ?? 480) * 60_000)
  let count = 0
  for (const e of employees) {
    const a = createQuizAssignment(deps.db, {
      quiz_id: quiz.id, employee_id: e.id, course_assignment_id: null,
      slot_at: slotAt.toISOString(), assigned_at: now.toISOString(), due_at: due.toISOString(),
    })
    if (!a) continue
    count++
    if (e.telegram_id !== null) {
      await deps.notifier.toEmployee(e.telegram_id, `Новый тест: «${quiz.title}». Срок: до ${formatLocal(due, deps.tz, now)}`, {
        keyboard: startQuizKeyboard(a.id),
      })
    }
  }
  return count
}
```

Run: `npx vitest run server/learning/assign.test.ts` → 3 passed.

- [ ] **Step 4: Тесты шагов планировщика**

`server/scheduler/learning.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { publishCourse } from '../db/courses.js'
import { getQuiz, setQuizStatus } from '../db/quizzes.js'
import { createCourseAssignment, createQuizAssignment, getCourseAssignment, getQuizAssignment, listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import type { SchedulerDeps } from './tick.js'
import { assignCourses, issueDueQuizzes, learningOverdue, learningReminders } from './learning.js'

const T = (iso: string) => new Date(iso)
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
let deps: SchedulerDeps

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir: '/tmp', reviewQueue: { enqueue: () => true, isActive: () => false } }
})

describe('assignCourses', () => {
  it('assigns published courses to eligible employees, honouring assign_existing', async () => {
    const { course: all } = seedCourse(db, [seed.positions.barista.id])
    const { course: onlyNew } = seedCourse(db, [seed.positions.cook.id], { title: 'Кухня' })
    publishCourse(db, all.id, true, '2026-09-07T09:00:00.000Z')
    publishCourse(db, onlyNew.id, false, '2099-01-01T00:00:00.000Z')
    expect(await assignCourses(deps, T('2026-09-07T10:00:00.000Z'))).toBe(2)
    expect(listCourseAssignments(db, { course_id: all.id })).toHaveLength(2)
    expect(listCourseAssignments(db, { course_id: onlyNew.id })).toHaveLength(0)
    expect(await assignCourses(deps, T('2026-09-07T10:01:00.000Z'))).toBe(0)
  })
})

describe('issueDueQuizzes', () => {
  it('issues a due quiz, advances next_run_at, skips old slots', async () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    setQuizStatus(db, quiz.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(await issueDueQuizzes(deps, T('2026-09-07T07:00:30.000Z'))).toBe(2)
    expect(getQuiz(db, quiz.id)?.next_run_at).toBe('2026-09-14T07:00:00.000Z')
    expect(listQuizAssignments(db, {})[0]?.due_at).toBe('2026-09-07T15:00:00.000Z')
    const late = seedQuiz(db, [seed.positions.cook.id], { title: 'Поздний' })
    setQuizStatus(db, late.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(await issueDueQuizzes(deps, T('2026-09-07T08:30:00.000Z'))).toBe(0)
    expect(getQuiz(db, late.id)?.next_run_at).toBe('2026-09-14T07:00:00.000Z')
  })
})

describe('learningReminders', () => {
  it('reminds about courses 24h before (long) or at half time (short), quizzes at half time, once', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-08T10:00:00.000Z' })
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-09-07T00:00:00.000Z', due_at: '2026-09-08T00:00:00.000Z' })
    createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: '2026-09-07T07:00:00.000Z', assigned_at: '2026-09-07T07:00:00.000Z', due_at: '2026-09-07T15:00:00.000Z' })
    expect(await learningReminders(deps, T('2026-09-07T09:00:00.000Z'))).toBe(0)
    expect(await learningReminders(deps, T('2026-09-07T11:30:00.000Z'))).toBe(2) // курс Ивана (24 ч) и тест (половина 8 ч)
    expect(await learningReminders(deps, T('2026-09-07T12:30:00.000Z'))).toBe(1) // курс Анны (половина суток)
    expect(await learningReminders(deps, T('2026-09-07T13:00:00.000Z'))).toBe(0)
    expect(log.filter((n) => /Напоминание/.test(n.text))).toHaveLength(3)
  })
})

describe('learningOverdue', () => {
  it('marks overdue course and quiz assignments and notifies both sides', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const ca = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-06T10:00:00.000Z' })!
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.anna.id, course_assignment_id: null, slot_at: '2026-09-06T07:00:00.000Z', assigned_at: '2026-09-06T07:00:00.000Z', due_at: '2026-09-06T15:00:00.000Z' })!
    expect(await learningOverdue(deps, T('2026-09-07T10:00:00.000Z'))).toBe(2)
    expect(getCourseAssignment(db, ca.id)?.status).toBe('overdue')
    expect(getQuizAssignment(db, qa.id)?.status).toBe('overdue')
    expect(log.filter((n) => n.to === 'owner')).toHaveLength(2)
    expect(log.filter((n) => n.to === 500 || n.to === 501)).toHaveLength(2)
    expect(await learningOverdue(deps, T('2026-09-07T10:01:00.000Z'))).toBe(0)
  })
})
```

Run: `npx vitest run server/scheduler/learning.test.ts` → FAIL.

- [ ] **Step 5: server/scheduler/learning.ts**

```ts
import { listPublishedCourses } from '../db/courses.js'
import { getEmployee } from '../db/employees.js'
import { listDueQuizzes, setQuizNextRunAt } from '../db/quizzes.js'
import {
  getCourseAssignmentRow, getQuizAssignmentRow, listCourseOverdueCandidates, listCourseReminderCandidates,
  listQuizOverdueCandidates, listQuizReminderCandidates, markCourseReminderSent, markQuizReminderSent,
  setCourseAssignmentStatus, setQuizAssignmentStatus,
} from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import { assignCourse, issueQuiz } from '../learning/assign.js'
import { nextRun } from '../tasks/schedule.js'
import { continueCourseKeyboard, startQuizKeyboard } from '../bot/keyboards.js'
import { MISSED_SLOT_GRACE_MS } from './issueDue.js'
import type { SchedulerDeps } from './tick.js'

const DAY = 24 * 60 * 60_000

export async function assignCourses(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const course of listPublishedCourses(deps.db)) {
    try {
      count += await assignCourse(deps, course, now, !course.assign_existing)
    } catch (err) {
      console.error('scheduler: course assignment failed', course.id, err)
    }
  }
  return count
}

export async function issueDueQuizzes(deps: SchedulerDeps, now: Date): Promise<number> {
  let issued = 0
  for (const quiz of listDueQuizzes(deps.db, now.toISOString())) {
    if (!quiz.schedule || !quiz.next_run_at) continue
    try {
      const slot = new Date(quiz.next_run_at)
      if (now.getTime() - slot.getTime() > MISSED_SLOT_GRACE_MS) {
        console.warn(`scheduler: skipping missed quiz slot ${quiz.next_run_at} for quiz ${quiz.id}`)
      } else {
        issued += await issueQuiz(deps, quiz, slot, now)
      }
      const from = new Date(Math.max(slot.getTime(), now.getTime() - MISSED_SLOT_GRACE_MS))
      setQuizNextRunAt(deps.db, quiz.id, nextRun(quiz.schedule, from, deps.tz).toISOString())
    } catch (err) {
      console.error('scheduler: quiz issue failed', quiz.id, err)
    }
  }
  return issued
}

export function courseReminderLeadMs(durationMs: number): number {
  return durationMs > 2 * DAY ? DAY : Math.floor(durationMs / 2)
}

export async function learningReminders(deps: SchedulerDeps, now: Date): Promise<number> {
  let sent = 0
  for (const a of listCourseReminderCandidates(deps.db, now.toISOString())) {
    const due = new Date(a.due_at)
    const lead = courseReminderLeadMs(due.getTime() - new Date(a.assigned_at).getTime())
    if (due.getTime() - now.getTime() > lead) continue
    markCourseReminderSent(deps.db, a.id, now.toISOString())
    const row = getCourseAssignmentRow(deps.db, a.id)
    const e = getEmployee(deps.db, a.employee_id)
    if (!row || !e?.telegram_id) continue
    const id = await deps.notifier.toEmployee(e.telegram_id, `Напоминание: курс «${row.title}» нужно пройти до ${formatLocal(due, deps.tz, now)}`, {
      keyboard: continueCourseKeyboard(a.id),
    })
    if (id !== null) sent++
  }
  for (const a of listQuizReminderCandidates(deps.db, now.toISOString())) {
    const due = new Date(a.due_at)
    const lead = Math.floor((due.getTime() - new Date(a.assigned_at).getTime()) / 2)
    if (due.getTime() - now.getTime() > lead) continue
    markQuizReminderSent(deps.db, a.id, now.toISOString())
    const row = getQuizAssignmentRow(deps.db, a.id)
    const e = getEmployee(deps.db, a.employee_id)
    if (!row || !e?.telegram_id) continue
    const id = await deps.notifier.toEmployee(e.telegram_id, `Напоминание: тест «${row.title}» нужно пройти до ${formatLocal(due, deps.tz, now)}`, {
      keyboard: startQuizKeyboard(a.id, row.open_attempt_id ? 'Продолжить' : 'Начать'),
    })
    if (id !== null) sent++
  }
  return sent
}

export async function learningOverdue(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const a of listCourseOverdueCandidates(deps.db, now.toISOString())) {
    setCourseAssignmentStatus(deps.db, a.id, 'overdue')
    count++
    const row = getCourseAssignmentRow(deps.db, a.id)
    const e = getEmployee(deps.db, a.employee_id)
    if (!row) continue
    if (e?.telegram_id) await deps.notifier.toEmployee(e.telegram_id, `Курс «${row.title}» просрочен. Пройдите его как можно скорее.`, { keyboard: continueCourseKeyboard(a.id) })
    await deps.notifier.toOwner(`${row.employee_name} просрочил(а) курс «${row.title}».`)
  }
  for (const a of listQuizOverdueCandidates(deps.db, now.toISOString())) {
    setQuizAssignmentStatus(deps.db, a.id, 'overdue')
    count++
    const row = getQuizAssignmentRow(deps.db, a.id)
    const e = getEmployee(deps.db, a.employee_id)
    if (!row) continue
    if (e?.telegram_id) await deps.notifier.toEmployee(e.telegram_id, `Тест «${row.title}» просрочен. Пройдите его как можно скорее.`, { keyboard: startQuizKeyboard(a.id) })
    await deps.notifier.toOwner(`${row.employee_name} просрочил(а) тест «${row.title}».`)
  }
  return count
}
```

`server/scheduler/tick.ts`: импортировать четыре функции и добавить после `retryReviews`:
```ts
      await step('assignCourses', () => assignCourses(deps, t))
      await step('issueDueQuizzes', () => issueDueQuizzes(deps, t))
      await step('learningReminders', () => learningReminders(deps, t))
      await step('learningOverdue', () => learningOverdue(deps, t))
```

Run: `npx vitest run server/scheduler` → все passed.

- [ ] **Step 6: Всё зелёное, commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/bot/callbacks.ts server/bot/keyboards.ts server/learning server/scheduler
git commit -m "feat: course assignment service and learning scheduler steps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API обучения и загрузка картинок

**Files:**
- Create: `server/api/learning.ts`, `server/api/learning.test.ts`
- Modify: `server/app.ts` (регистрация `learningRoutes` в защищённом scope: `scope.register(learningRoutes, { db, notifier, tz: config.TZ, uploadsDir: deps.uploadsDir })`)

**Interfaces (все за сессией владельца):**
- `GET /api/learning/courses?includeArchived=1` → `Course[]`; `GET /api/learning/courses/:id` → `{ course: Course; lessons: Lesson[]; quiz: Quiz | null; questions: Question[] }`; `POST /api/learning/courses` тело `CourseBody` → 201 тот же объект; `PATCH /api/learning/courses/:id` → 200 / 404; `POST /api/learning/courses/:id/publish` `{ assign_existing: boolean }` → 200 `{ course: Course; assigned: number }` / 409 `{ error: 'incomplete', issues: string[] }` / 404; `POST /api/learning/courses/:id/archive` → 200 `Course`.
- `CourseBody` = `{ title 1..200, description ≤ 2000 default '', due_days int 1..365, pass_score int 0..100 default 80, position_ids number[] default [], lessons: { title 1..200, body ≤ 5000 default '', media: ({kind:'image', path} | {kind:'video', url: z.string().url()})[] default [] }[] default [], questions: { text 1..500, options string[] 2..5 непустых, correct_index int 0..4 < options.length }[] default [] }`. Создание/обновление курса сохраняет уроки (`replaceLessons`), создаёт при отсутствии курсовой quiz (`createQuiz` с `course_id`, `pass_score` курса, `position_ids: []`) и сохраняет вопросы (`replaceQuestions`); `pass_score` курса дублируется в quiz.
- `GET /api/learning/quizzes?includeArchived=1` → `Quiz[]` (отдельные); `GET /api/learning/quizzes/:id` → `{ quiz: Quiz; questions: Question[] }`; `POST /api/learning/quizzes` `QuizBody` → 201; `PATCH /api/learning/quizzes/:id`; `POST /api/learning/quizzes/:id/publish` → 200 `Quiz` / 409 `incomplete`; `POST /api/learning/quizzes/:id/issue` → 200 `{ assigned: number }` (409 если не опубликован); `POST /api/learning/quizzes/:id/archive`.
- `QuizBody` = `{ title, pass_score, position_ids (min 1 при publish), schedule: weekly | null (interval → 400), deadline_minutes int ≥ 15, questions как выше }`. `next_run_at` = `nextRun(schedule, now, tz)` при наличии расписания и статусе `published` (при publish пересчитывается).
- `GET /api/learning/assignments/courses?course_id&employee_id&status` → `CourseAssignmentRow[]`; `GET /api/learning/assignments/quizzes?quiz_id&employee_id&status` → `QuizAssignmentRow[]`; `GET /api/learning/assignments/quizzes/:id/attempts` → `QuizAttempt[]`.
- `POST /api/learning/upload` `{ filename: string, mime: 'image/jpeg' | 'image/png' | 'image/webp', data: base64 }` → 201 `{ path: 'lessons/<yyyy-mm>/<random>.<ext>' }`; 400 при другом mime или размере > 5 МБ. Файл пишется в `uploadsDir/<path>`; роут регистрируется с `bodyLimit: 8 * 1024 * 1024`.

- [ ] **Step 1: Тесты API**

`server/api/learning.test.ts`:
```ts
import { existsSync } from 'node:fs'
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

const courseBody = (positionIds: number[]) => ({
  title: 'Эспрессо по стандарту', description: 'Базовый курс', due_days: 7, pass_score: 80, position_ids: positionIds,
  lessons: [
    { title: 'Помол', body: '18 г', media: [] },
    { title: 'Экстракция', body: '25–30 с', media: [{ kind: 'image', path: 'lessons/2026-09/a.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }] },
  ],
  questions: [{ text: 'Сколько секунд?', options: ['10', '25–30'], correct_index: 1 }],
})

describe('courses api', () => {
  it('creates, reads, updates, publishes and archives a course', async () => {
    const { app, seed, h, notifications } = await setup()
    const created = await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: courseBody([seed.positions.barista.id]) })
    expect(created.statusCode).toBe(201)
    expect(created.json().course).toMatchObject({ status: 'draft', lesson_count: 2 })
    expect(created.json().lessons).toHaveLength(2)
    expect(created.json().quiz).toMatchObject({ course_id: created.json().course.id, question_count: 1 })
    const id = created.json().course.id

    const read = await app.inject({ method: 'GET', url: `/api/learning/courses/${id}`, headers: h })
    expect(read.json().questions[0]).toMatchObject({ text: 'Сколько секунд?', correct_index: 1 })

    const upd = await app.inject({ method: 'PATCH', url: `/api/learning/courses/${id}`, headers: h, payload: { ...courseBody([seed.positions.barista.id]), title: 'Эспрессо', questions: [] } })
    expect(upd.json().course.title).toBe('Эспрессо')
    const incomplete = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/publish`, headers: h, payload: { assign_existing: true } })
    expect(incomplete.statusCode).toBe(409)
    expect(incomplete.json().issues.join(' ')).toMatch(/вопрос/i)

    await app.inject({ method: 'PATCH', url: `/api/learning/courses/${id}`, headers: h, payload: courseBody([seed.positions.barista.id]) })
    const published = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/publish`, headers: h, payload: { assign_existing: true } })
    expect(published.statusCode).toBe(200)
    expect(published.json()).toMatchObject({ course: { status: 'published', assign_existing: true }, assigned: 2 })
    expect(notifications.filter((n) => typeof n.to === 'number' && /Новый курс/.test(n.text))).toHaveLength(2)

    const list = await app.inject({ method: 'GET', url: '/api/learning/assignments/courses?status=in_progress', headers: h })
    expect(list.json()).toHaveLength(2)
    const archived = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/archive`, headers: h })
    expect(archived.json().status).toBe('archived')
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses', headers: h })).json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses?includeArchived=1', headers: h })).json()).toHaveLength(1)
  })

  it('validates the body', async () => {
    const { app, seed, h } = await setup()
    const bad = { ...courseBody([seed.positions.barista.id]), questions: [{ text: 'x', options: ['a'], correct_index: 0 }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: bad })).statusCode).toBe(400)
    const badIndex = { ...courseBody([seed.positions.barista.id]), questions: [{ text: 'x', options: ['a', 'b'], correct_index: 2 }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: badIndex })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses' })).statusCode).toBe(401)
  })
})

describe('quizzes api', () => {
  it('creates a scheduled quiz, publishes it with next_run_at and issues it now', async () => {
    const { app, seed, h, notifications } = await setup()
    const body = {
      title: 'Меню недели', pass_score: 80, position_ids: [seed.positions.barista.id],
      schedule: { kind: 'weekly', days: [1], times: ['10:00'] }, deadline_minutes: 480,
      questions: [{ text: 'Цена капучино?', options: ['250', '300'], correct_index: 1 }],
    }
    const created = await app.inject({ method: 'POST', url: '/api/learning/quizzes', headers: h, payload: body })
    expect(created.statusCode).toBe(201)
    expect(created.json().quiz).toMatchObject({ status: 'draft', next_run_at: null, question_count: 1 })
    const id = created.json().quiz.id
    expect((await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/issue`, headers: h })).statusCode).toBe(409)
    const published = await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/publish`, headers: h })
    expect(published.json()).toMatchObject({ status: 'published' })
    expect(published.json().next_run_at).toMatch(/T07:00:00\.000Z$/)
    const issued = await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/issue`, headers: h })
    expect(issued.json()).toEqual({ assigned: 2 })
    expect(notifications.filter((n) => /Новый тест/.test(n.text))).toHaveLength(2)
    const rows = await app.inject({ method: 'GET', url: `/api/learning/assignments/quizzes?quiz_id=${id}`, headers: h })
    expect(rows.json()).toHaveLength(2)
    const attempts = await app.inject({ method: 'GET', url: `/api/learning/assignments/quizzes/${rows.json()[0].id}/attempts`, headers: h })
    expect(attempts.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/learning/quizzes', headers: h })).json()).toHaveLength(1)
    const interval = { ...body, schedule: { kind: 'interval', days: [1], from: '10:00', to: '12:00', every_minutes: 60 } }
    expect((await app.inject({ method: 'POST', url: '/api/learning/quizzes', headers: h, payload: interval })).statusCode).toBe(400)
  })
})

describe('upload', () => {
  it('stores an image and rejects other types', async () => {
    const { app, h, uploadsDir } = await setup()
    const ok = await app.inject({ method: 'POST', url: '/api/learning/upload', headers: h, payload: { filename: 'a.jpg', mime: 'image/jpeg', data: Buffer.from('jpegdata').toString('base64') } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().path).toMatch(/^lessons\/\d{4}-\d{2}\/[a-f0-9]+\.jpg$/)
    expect(existsSync(join(uploadsDir, ok.json().path))).toBe(true)
    const served = await app.inject({ method: 'GET', url: `/api/uploads/${ok.json().path}`, headers: h })
    expect(served.body).toBe('jpegdata')
    const bad = await app.inject({ method: 'POST', url: '/api/learning/upload', headers: h, payload: { filename: 'a.gif', mime: 'image/gif', data: 'AAAA' } })
    expect(bad.statusCode).toBe(400)
  })
})
```

Run: `npx vitest run server/api/learning.test.ts` → FAIL.

- [ ] **Step 2: server/api/learning.ts**

```ts
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  createCourse, getCourse, listCourses, listLessons, publishCourse, replaceLessons, setCourseStatus, updateCourse, type Course, type CourseInput,
} from '../db/courses.js'
import {
  createQuiz, getCourseQuiz, getQuiz, listQuestions, listQuizzes, replaceQuestions, setQuizStatus, updateQuiz, type Quiz,
} from '../db/quizzes.js'
import { listAttempts, listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { idParams, parse } from '../lib/validate.js'
import type { Notifier } from '../notify.js'
import { assignCourse, issueQuiz } from '../learning/assign.js'
import { nextRun, scheduleSchema } from '../tasks/schedule.js'

type Opts = { db: Db; notifier: Notifier; tz: string; uploadsDir: string; now?: () => Date }

const media = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), path: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('video'), url: z.string().url().max(500) }),
])
const lesson = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().max(5000).default(''), media: z.array(media).default([]) })
const question = z
  .object({ text: z.string().trim().min(1).max(500), options: z.array(z.string().trim().min(1).max(200)).min(2).max(5), correct_index: z.number().int().min(0).max(4) })
  .refine((q) => q.correct_index < q.options.length, { message: 'Правильный ответ должен быть одним из вариантов', path: ['correct_index'] })

const courseBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  due_days: z.number().int().min(1).max(365),
  pass_score: z.number().int().min(0).max(100).default(80),
  position_ids: z.array(z.number().int().positive()).default([]),
  lessons: z.array(lesson).default([]),
  questions: z.array(question).default([]),
})
const publishBody = z.object({ assign_existing: z.boolean() })
const weeklyOnly = scheduleSchema.refine((s) => s.kind === 'weekly', { message: 'Для тестов доступно только расписание по дням недели' })
const quizBody = z.object({
  title: z.string().trim().min(1).max(200),
  pass_score: z.number().int().min(0).max(100).default(80),
  position_ids: z.array(z.number().int().positive()).default([]),
  schedule: weeklyOnly.nullable(),
  deadline_minutes: z.number().int().min(15),
  questions: z.array(question).default([]),
})
const uploadBody = z.object({
  filename: z.string().min(1).max(200),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(1),
})
const listQuery = z.object({ includeArchived: z.string().optional() })
const courseAssignmentsQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['in_progress', 'completed', 'overdue']).optional(),
})
const quizAssignmentsQuery = z.object({
  quiz_id: z.coerce.number().int().positive().optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'passed', 'overdue']).optional(),
})

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_IMAGE = 5 * 1024 * 1024

export const learningRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, notifier, tz, uploadsDir } = opts
  const now = opts.now ?? (() => new Date())
  const learningDeps = { db, notifier, tz }

  function courseDetails(course: Course) {
    const quiz = getCourseQuiz(db, course.id)
    return { course, lessons: listLessons(db, course.id), quiz, questions: quiz ? listQuestions(db, quiz.id) : [] }
  }

  function saveCourseParts(course: Course, body: z.infer<typeof courseBody>): void {
    replaceLessons(db, course.id, body.lessons)
    const quiz =
      getCourseQuiz(db, course.id) ??
      createQuiz(db, { title: `Итоговый тест: ${course.title}`, course_id: course.id, pass_score: body.pass_score, schedule: null, deadline_minutes: null, position_ids: [] }, null)
    updateQuiz(db, quiz.id, { title: `Итоговый тест: ${course.title}`, course_id: course.id, pass_score: body.pass_score, schedule: null, deadline_minutes: null, position_ids: [] }, null)
    replaceQuestions(db, quiz.id, body.questions)
  }

  function courseIssues(course: Course): string[] {
    const issues: string[] = []
    if (course.position_ids.length === 0) issues.push('Выберите хотя бы одну должность')
    if (course.lesson_count === 0) issues.push('Добавьте хотя бы один урок')
    const quiz = getCourseQuiz(db, course.id)
    if (!quiz || quiz.question_count === 0) issues.push('Добавьте хотя бы один вопрос в итоговый тест')
    return issues
  }

  app.get('/api/learning/courses', async (req) => {
    const q = parse(listQuery, req.query)
    return listCourses(db, { includeArchived: q.includeArchived === '1' })
  })

  app.get('/api/learning/courses/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const course = getCourse(db, id)
    return course ? courseDetails(course) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/courses', async (req, reply) => {
    const body = parse(courseBody, req.body)
    const input: CourseInput = { title: body.title, description: body.description, due_days: body.due_days, pass_score: body.pass_score, position_ids: body.position_ids }
    const course = db.transaction(() => {
      const c = createCourse(db, input)
      saveCourseParts(c, body)
      return getCourse(db, c.id)!
    })()
    return reply.code(201).send(courseDetails(course))
  })

  app.patch('/api/learning/courses/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const body = parse(courseBody, req.body)
    const input: CourseInput = { title: body.title, description: body.description, due_days: body.due_days, pass_score: body.pass_score, position_ids: body.position_ids }
    const course = db.transaction(() => {
      const c = updateCourse(db, id, input)
      if (!c) return null
      saveCourseParts(c, body)
      return getCourse(db, id)
    })()
    return course ? courseDetails(course) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/courses/:id/publish', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const { assign_existing } = parse(publishBody, req.body)
    const course = getCourse(db, id)
    if (!course) return reply.code(404).send({ error: 'not_found' })
    const issues = courseIssues(course)
    if (issues.length) return reply.code(409).send({ error: 'incomplete', issues })
    const t = now()
    const published = publishCourse(db, id, assign_existing, t.toISOString())!
    const assigned = assign_existing ? await assignCourse(learningDeps, published, t, false) : 0
    return { course: getCourse(db, id), assigned }
  })

  app.post('/api/learning/courses/:id/archive', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setCourseStatus(db, id, 'archived') ?? reply.code(404).send({ error: 'not_found' })
  })

  const quizDetails = (quiz: Quiz) => ({ quiz, questions: listQuestions(db, quiz.id) })
  const quizNextRun = (quiz: { schedule: Quiz['schedule']; status: Quiz['status'] }) =>
    quiz.schedule && quiz.status === 'published' ? nextRun(quiz.schedule, now(), tz).toISOString() : null

  app.get('/api/learning/quizzes', async (req) => {
    const q = parse(listQuery, req.query)
    return listQuizzes(db, { includeArchived: q.includeArchived === '1' })
  })

  app.get('/api/learning/quizzes/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    return quiz && quiz.course_id === null ? quizDetails(quiz) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/quizzes', async (req, reply) => {
    const body = parse(quizBody, req.body)
    const quiz = db.transaction(() => {
      const q = createQuiz(db, { title: body.title, course_id: null, pass_score: body.pass_score, schedule: body.schedule, deadline_minutes: body.deadline_minutes, position_ids: body.position_ids }, null)
      replaceQuestions(db, q.id, body.questions)
      return getQuiz(db, q.id)!
    })()
    return reply.code(201).send(quizDetails(quiz))
  })

  app.patch('/api/learning/quizzes/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const body = parse(quizBody, req.body)
    const current = getQuiz(db, id)
    if (!current || current.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    const quiz = db.transaction(() => {
      const q = updateQuiz(db, id, { title: body.title, course_id: null, pass_score: body.pass_score, schedule: body.schedule, deadline_minutes: body.deadline_minutes, position_ids: body.position_ids }, quizNextRun({ schedule: body.schedule, status: current.status }))!
      replaceQuestions(db, q.id, body.questions)
      return getQuiz(db, id)!
    })()
    return quizDetails(quiz)
  })

  app.post('/api/learning/quizzes/:id/publish', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    if (!quiz || quiz.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    const issues: string[] = []
    if (quiz.position_ids.length === 0) issues.push('Выберите хотя бы одну должность')
    if (quiz.question_count === 0) issues.push('Добавьте хотя бы один вопрос')
    if (issues.length) return reply.code(409).send({ error: 'incomplete', issues })
    return setQuizStatus(db, id, 'published', quizNextRun({ schedule: quiz.schedule, status: 'published' }))
  })

  app.post('/api/learning/quizzes/:id/issue', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    if (!quiz || quiz.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    if (quiz.status !== 'published') return reply.code(409).send({ error: 'not_published' })
    const t = now()
    return { assigned: await issueQuiz(learningDeps, quiz, t, t) }
  })

  app.post('/api/learning/quizzes/:id/archive', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setQuizStatus(db, id, 'archived', null) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.get('/api/learning/assignments/courses', async (req) => listCourseAssignments(db, parse(courseAssignmentsQuery, req.query)))
  app.get('/api/learning/assignments/quizzes', async (req) => listQuizAssignments(db, parse(quizAssignmentsQuery, req.query)))
  app.get('/api/learning/assignments/quizzes/:id/attempts', async (req) => {
    const { id } = parse(idParams, req.params)
    return listAttempts(db, id)
  })

  app.post('/api/learning/upload', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(uploadBody, req.body)
    const data = Buffer.from(body.data, 'base64')
    if (data.length === 0 || data.length > MAX_IMAGE) return reply.code(400).send({ error: 'validation', issues: [{ message: 'Картинка до 5 МБ' }] })
    const month = now().toISOString().slice(0, 7)
    const rel = join('lessons', month, `${randomBytes(8).toString('hex')}.${EXT[body.mime]}`)
    mkdirSync(join(uploadsDir, 'lessons', month), { recursive: true })
    writeFileSync(join(uploadsDir, rel), data)
    return reply.code(201).send({ path: rel })
  })
}
```

`server/app.ts`: импорт `learningRoutes` и регистрация в защищённом scope после `taskRoutes`.

Run: `npx vitest run server/api/learning.test.ts` → 4 passed. Run: `npm test && npm run typecheck` → зелёные.

- [ ] **Step 3: Commit**

```bash
git add server/api/learning.ts server/api/learning.test.ts server/app.ts
git commit -m "feat: learning API for courses, quizzes, assignments and lesson images

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Бот «Обучение»: список, уроки, переход к тесту

**Files:**
- Create: `server/bot/learning.ts`, `server/bot/learning.test.ts`
- Modify: `server/bot/createBot.ts` (регистрация `registerLearning` после `registerReview`), `server/bot/linking.ts` (убрать `BTN.learning` и `BTN.quizzes` из заглушки, оставить только `BTN.rating`)

**Interfaces:**
- `registerLearning(bot: Bot<BotContext>, deps: BotDeps)`: `hears(BTN.learning)`, callbacks `CB_RE.courseContinue`, `CB_RE.courseNext`.
- Экспорт `sendLesson(ctx: BotContext, deps: BotDeps, assignment: CourseAssignmentRow): Promise<void>` (используется и напоминаниями? нет, только ботом) и `ensureCourseQuizAssignment(db, assignment: CourseAssignment, nowIso): QuizAssignment` (идемпотентно создаёт назначение итогового теста со `slot_at` = `nowIso` при первом вызове; при повторном возвращает существующее по `course_assignment_id`). Для поиска существующего добавить в `learningAssignments.ts` функцию `findQuizAssignmentForCourse(db, courseAssignmentId): QuizAssignment | null`.
- Тексты: «Курсов нет.», строка списка `«<название>», урок N из M, до <срок>` со статусом «просрочен» при `overdue`, завершённые: `Пройдено: «<название>»`; урок: первое сообщение `Урок N из M: <заголовок>\n\n<текст>`; картинки `replyWithPhoto(new InputFile(join(uploadsDir, path)))`; видео `ctx.reply(url)`; последнее сообщение «Нажмите, когда прочитаете.» с `nextLessonKeyboard`; после последнего урока «Уроки пройдены, остался итоговый тест.» с `startQuizKeyboard(quizAssignmentId, 'Пройти тест')`; «Это не ваш курс.», «Курс уже завершён.», всплывающее «Уже отмечено.» при повторном «Дальше».

- [ ] **Step 1: Тесты**

`server/bot/learning.test.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { publishCourse } from '../db/courses.js'
import { createCourseAssignment, getCourseAssignment, listQuizAssignments } from '../db/learningAssignments.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import { callbackUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'
import type { BotContext } from './states.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let seed: ReturnType<typeof seedRestaurant>
let uploadsDir: string

const sent = () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')
const lastText = () => String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload.text ?? '')
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  const made = makeBot(db, { now: () => new Date(NOW) })
  bot = made.bot
  calls = made.calls
  uploadsDir = made.deps.uploadsDir
  mkdirSync(join(uploadsDir, 'lessons'), { recursive: true })
  writeFileSync(join(uploadsDir, 'lessons', 'test.jpg'), 'jpeg')
})

function assigned() {
  const { course } = seedCourse(db, [seed.positions.barista.id])
  publishCourse(db, course.id, true, NOW)
  return createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
}

describe('course list', () => {
  it('shows an empty list, then assignments with progress and a Continue button', async () => {
    await bot.handleUpdate(textUpdate(500, 'Обучение'))
    expect(lastText()).toBe('Курсов нет.')
    const a = assigned()
    await bot.handleUpdate(textUpdate(500, 'Обучение'))
    expect(lastText()).toContain('«Эспрессо по стандарту», урок 1 из 3')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.courseContinue(a.id))
  })
})

describe('lessons', () => {
  it('sends the lesson text, media and the next button; refuses foreign assignments', async () => {
    const a = assigned()
    await bot.handleUpdate(callbackUpdate(501, CB.courseContinue(a.id)))
    expect(lastAnswer()).toBe('Это не ваш курс.')
    calls.length = 0
    await bot.handleUpdate(callbackUpdate(500, CB.courseContinue(a.id)))
    expect(sent()[0]!.payload.text).toContain('Урок 1 из 3: Помол и дозировка')
    expect(String(sent()[0]!.payload.text)).toContain('18 г')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.courseNext(a.id, 1))
  })

  it('advances through lessons with media, ignores a repeated Next, then offers the quiz', async () => {
    const a = assigned()
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 1)))
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    const photo = calls.find((c) => c.method === 'sendPhoto')
    expect(photo).toBeDefined()
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('https://youtu.be/x'))).toBe(true)
    expect(lastText()).toBe('Нажмите, когда прочитаете.')
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 1)))
    expect(lastAnswer()).toBe('Уже отмечено.')
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 2)))
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(3)
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 3)))
    expect(lastText()).toBe('Уроки пройдены, остался итоговый тест.')
    const qa = listQuizAssignments(db, { employee_id: seed.employees.ivan.id })
    expect(qa).toHaveLength(1)
    expect(qa[0]).toMatchObject({ course_assignment_id: a.id, status: 'pending', due_at: '2026-09-14T10:00:00.000Z' })
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.quizStart(qa[0]!.id))
    // повторное «Дальше» на последнем уроке не создаёт второе назначение
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 3)))
    expect(listQuizAssignments(db, { employee_id: seed.employees.ivan.id })).toHaveLength(1)
  })
})
```

Run: `npx vitest run server/bot/learning.test.ts` → FAIL.

- [ ] **Step 2: findQuizAssignmentForCourse**

В `server/db/learningAssignments.ts`:
```ts
export function findQuizAssignmentForCourse(db: Db, courseAssignmentId: number): QuizAssignment | null {
  return (db.prepare(`select ${qaCols} from quiz_assignments a where a.course_assignment_id = ?`).get(courseAssignmentId) as QuizAssignment) ?? null
}
```

- [ ] **Step 3: server/bot/learning.ts**

```ts
import { join } from 'node:path'
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
    if (m.kind === 'image') await ctx.replyWithPhoto(new InputFile(join(deps.uploadsDir, m.path)))
    else await ctx.reply(m.url)
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
```

`server/bot/linking.ts`: `bot.hears([BTN.learning, BTN.quizzes, BTN.rating], …)` → `bot.hears(BTN.rating, …)` (текст заглушки тот же). Тест в `createBot.test.ts`, нажимающий «Обучение» и ожидающий «появится», переключить на «Мой рейтинг».

`server/bot/createBot.ts`: после `registerReview(bot, deps)` добавить `registerLearning(bot, deps)`.

Run: `npx vitest run server/bot` → все passed.

- [ ] **Step 4: Commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/bot server/db/learningAssignments.ts
git commit -m "feat(bot): course list, lessons with media and hand-off to the final quiz

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Бот «Тесты»: попытки, ответы, результат

**Files:**
- Create: `server/bot/quiz.ts`, `server/bot/quiz.test.ts`
- Modify: `server/bot/createBot.ts` (регистрация `registerQuizStates` среди состояний и `registerQuiz` после `registerLearning`)

**Interfaces:**
- `registerQuizStates(bot, deps)`: `onState(bot, 'quiz', …)`: любое сообщение → «Идёт тест, ответьте на вопрос N.» и повтор текущего вопроса (если попытка уже завершена или не найдена → `clearState` и `next()`).
- `registerQuiz(bot, deps)`: `hears(BTN.quizzes)` список, callbacks `CB_RE.quizStart`, `CB_RE.quizAnswer`.
- Экспорт `askQuestion(ctx, deps, attempt: QuizAttempt): Promise<void>` — отправляет `Вопрос N из M:\n<текст>` с `answersKeyboard`.
- Правила: `quizStart` — назначение принадлежит сотруднику и в статусе `pending`/`overdue` (иначе «Это не ваш тест.» / «Тест уже сдан.»); берётся открытая попытка или создаётся новая; ставится состояние `{ kind: 'quiz', attempt_id }`. `quizAnswer` — попытка принадлежит сотруднику, `recordAnswer` (false → всплывающее «Уже отвечено.»); если остались вопросы → следующий; иначе `finishAttempt` со `scoreAnswers`, состояние снимается; сдано → `markQuizPassed`, если `course_assignment_id` → `completeCourseAssignment` и владельцу «<сотрудник> прошёл(а) курс «<курс>» (<балл> из 100)», сотруднику «Сдано! <балл> из 100.»; не сдано → сотруднику «Не сдано: правильных K из M, нужно X%.» с `startQuizKeyboard(assignmentId, 'Пересдать')`, владельцу «<сотрудник> не сдал(а) тест «<название>»: <балл> из 100».
- Список «Тесты»: `«<название>», до <срок>` (+ «, просрочен») с кнопкой «Начать» или «Продолжить»; пусто «Тестов нет.».

- [ ] **Step 1: Тесты**

`server/bot/quiz.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { publishCourse } from '../db/courses.js'
import { createCourseAssignment, createQuizAssignment, getCourseAssignment, getQuizAssignment, listAttempts } from '../db/learningAssignments.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { callbackUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'
import type { BotContext } from './states.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let seed: ReturnType<typeof seedRestaurant>

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => ({ to: c.payload.chat_id, text: String(c.payload.text), markup: JSON.stringify(c.payload.reply_markup ?? {}) }))
const lastText = () => texts().at(-1)?.text ?? ''
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  ;({ bot, calls } = makeBot(db, { now: () => new Date(NOW) }))
})

function standalone() {
  const quiz = seedQuiz(db, [seed.positions.barista.id])
  return createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
}

describe('quiz list', () => {
  it('shows pending quizzes with Start, and Continue for an open attempt', async () => {
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(lastText()).toBe('Тестов нет.')
    const a = standalone()
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(lastText()).toContain('«Меню недели», до 21:00')
    expect(texts().at(-1)?.markup).toContain('Начать')
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    // в состоянии quiz кнопку меню перехватывает обработчик состояния: напоминание и повтор вопроса
    expect(texts().at(-2)?.text).toBe('Идёт тест, ответьте на вопрос 1.')
    expect(lastText()).toContain('Вопрос 1 из 2')
  })
})

describe('taking a quiz', () => {
  it('asks questions one by one, ignores stale answers, fails and allows a retake, then passes', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(501, CB.quizStart(a.id)))
    expect(lastAnswer()).toBe('Это не ваш тест.')
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastText()).toContain('Вопрос 1 из 2')
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('quiz')
    const attempt = listAttempts(db, a.id)[0]!
    // сообщение во время теста
    await bot.handleUpdate(textUpdate(500, 'привет'))
    expect(texts().at(-2)?.text).toBe('Идёт тест, ответьте на вопрос 1.')
    expect(lastText()).toContain('Вопрос 1 из 2')
    // ответ на не тот вопрос
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastAnswer()).toBe('Уже отвечено.')
    // неправильно, потом неправильно → провал
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 1)))
    expect(lastText()).toContain('Вопрос 2 из 2')
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastText()).toBe('Не сдано: правильных 0 из 2, нужно 80%.')
    expect(texts().at(-1)?.markup).toContain('Пересдать')
    expect(texts().some((t) => t.to === 42 && /не сдал/.test(t.text))).toBe(true)
    expect(getState(db, 500)).toBeNull()
    expect(getQuizAssignment(db, a.id)?.status).toBe('pending')
    // пересдача: оба верно
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const second = listAttempts(db, a.id)[1]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(second.id, 1, 0)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(second.id, 2, 1)))
    expect(lastText()).toBe('Сдано! 100 из 100.')
    expect(getQuizAssignment(db, a.id)).toMatchObject({ status: 'passed', passed_at: NOW })
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastAnswer()).toBe('Тест уже сдан.')
  })

  it('continues an open attempt from the current question', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const attempt = listAttempts(db, a.id)[0]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 0)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastText()).toContain('Вопрос 2 из 2')
    expect(listAttempts(db, a.id)).toHaveLength(1)
  })

  it('passing the course quiz completes the course and tells the owner', async () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    publishCourse(db, course.id, true, NOW)
    const ca = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    db.prepare('update course_assignments set current_lesson = 4 where id = ?').run(ca.id)
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: ca.id, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(qa.id)))
    const attempt = listAttempts(db, qa.id)[0]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 1)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastText()).toBe('Сдано! 100 из 100.')
    expect(getCourseAssignment(db, ca.id)).toMatchObject({ status: 'completed', completed_at: NOW })
    expect(texts().some((t) => t.to === 42 && t.text.includes('прошёл(а) курс «Эспрессо по стандарту»'))).toBe(true)
  })
})
```

Run: `npx vitest run server/bot/quiz.test.ts` → FAIL.

- [ ] **Step 2: server/bot/quiz.ts**

```ts
import type { Bot } from 'grammy'
import { clearState, setState } from '../db/botStates.js'
import { getCourse } from '../db/courses.js'
import { getQuiz, listQuestions } from '../db/quizzes.js'
import {
  completeCourseAssignment, createAttempt, finishAttempt, getAttempt, getCourseAssignment, getOpenAttempt, getQuizAssignmentRow,
  listEmployeeQuizAssignments, markQuizPassed, recordAnswer, type QuizAttempt, type QuizAssignmentRow,
} from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import { isPassed, scoreAnswers } from '../learning/score.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { answersKeyboard, BTN, employeeMenu, startQuizKeyboard } from './keyboards.js'
import { showHome } from './linking.js'
import { employeeOf, onState, type BotContext } from './states.js'

export async function askQuestion(ctx: BotContext, deps: BotDeps, attempt: QuizAttempt): Promise<void> {
  const row = getQuizAssignmentRow(deps.db, attempt.assignment_id)!
  const questions = listQuestions(deps.db, row.quiz_id)
  const q = questions.find((x) => x.position === attempt.current_question)
  if (!q) return
  await ctx.reply(`Вопрос ${q.position} из ${questions.length}:\n${q.text}`, { reply_markup: answersKeyboard(attempt.id, q.position, q.options) })
}

export function registerQuizStates(bot: Bot<BotContext>, deps: BotDeps): void {
  onState(bot, 'quiz', async (ctx, next) => {
    const attempt = getAttempt(deps.db, ctx.state.attempt_id)
    if (!attempt || attempt.finished_at) {
      clearState(deps.db, ctx.from!.id)
      return next()
    }
    await ctx.reply(`Идёт тест, ответьте на вопрос ${attempt.current_question}.`)
    await askQuestion(ctx, deps, attempt)
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
      await ctx.reply(`Не сдано: правильных ${correct} из ${total}, нужно ${quiz.pass_score}%.`, { reply_markup: startQuizKeyboard(row.id, 'Пересдать') })
      await deps.notifier.toOwner(`${row.employee_name} не сдал(а) тест «${row.title}»: ${score} из 100.`)
      return
    }
    markQuizPassed(db, row.id, nowIso)
    await ctx.reply(`Сдано! ${score} из 100.`, { reply_markup: employeeMenu() })
    if (row.course_assignment_id !== null) {
      completeCourseAssignment(db, row.course_assignment_id, nowIso)
      const ca = getCourseAssignment(db, row.course_assignment_id)
      const course = ca ? getCourse(db, ca.course_id) : null
      await deps.notifier.toOwner(`${row.employee_name} прошёл(а) курс «${course?.title ?? row.title}» (${score} из 100).`)
    }
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
    if (fresh.current_question <= total) return askQuestion(ctx, deps, fresh)
    await finish(ctx, fresh, row)
  })
}
```

`server/bot/createBot.ts`: `registerQuizStates(bot, deps)` после `registerReviewStates`; `registerQuiz(bot, deps)` после `registerLearning`.

Run: `npx vitest run server/bot` → все passed.

- [ ] **Step 3: Commit**

Run: `npm test && npm run typecheck` → зелёные.

```bash
git add server/bot
git commit -m "feat(bot): quiz attempts question by question with retakes and owner notifications

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Админка: курсы, тесты, прогресс

**Files:**
- Modify: `admin/src/api.ts`, `admin/src/router.ts`, `admin/src/components/AppLayout.vue`
- Create: `admin/src/components/QuestionsEditor.vue`, `admin/src/pages/CoursesPage.vue`, `admin/src/pages/CourseForm.vue`, `admin/src/pages/QuizzesPage.vue`, `admin/src/pages/QuizForm.vue`, `admin/src/pages/ProgressPage.vue`

**Interfaces:**
- Маршруты: `/learning/courses`, `/learning/courses/new`, `/learning/courses/:id/edit`, `/learning/quizzes`, `/learning/quizzes/new`, `/learning/quizzes/:id/edit`, `/learning/progress`. В шапке пункты «Курсы», «Тесты», «Прогресс» после «Проверка фото».
- `api.learning` с методами под контракт Task 4. Загрузка картинки: `api.learning.upload(file: File)` читает файл через `FileReader` в base64 и шлёт `{ filename, mime, data }`.
- Юнит-тестов на Vue нет; проверка `npm run build` и ручной прогон в Task 8.

- [ ] **Step 1: admin/src/api.ts**

Добавить типы:
```ts
export type Media = { kind: 'image'; path: string } | { kind: 'video'; url: string }
export type Lesson = { id?: number; title: string; body: string; media: Media[] }
export type Question = { id?: number; text: string; options: string[]; correct_index: number }
export type Course = {
  id: number; title: string; description: string; due_days: number; pass_score: number
  status: 'draft' | 'published' | 'archived'; published_at: string | null; assign_existing: boolean
  created_at: string; position_ids: number[]; lesson_count: number
}
export type CourseBody = { title: string; description: string; due_days: number; pass_score: number; position_ids: number[]; lessons: Lesson[]; questions: Question[] }
export type CourseDetails = { course: Course; lessons: Lesson[]; quiz: Quiz | null; questions: Question[] }
export type Quiz = {
  id: number; title: string; course_id: number | null; pass_score: number; schedule: Schedule | null; deadline_minutes: number | null
  status: 'draft' | 'published' | 'archived'; next_run_at: string | null; created_at: string; position_ids: number[]; question_count: number
}
export type QuizBody = { title: string; pass_score: number; position_ids: number[]; schedule: Schedule | null; deadline_minutes: number; questions: Question[] }
export type CourseAssignmentRow = {
  id: number; course_id: number; employee_id: number; assigned_at: string; due_at: string; current_lesson: number
  status: 'in_progress' | 'completed' | 'overdue'; completed_at: string | null; title: string; lesson_count: number; employee_name: string
}
export type QuizAssignmentRow = {
  id: number; quiz_id: number; employee_id: number; course_assignment_id: number | null; slot_at: string; assigned_at: string; due_at: string
  status: 'pending' | 'passed' | 'overdue'; passed_at: string | null; title: string; employee_name: string; open_attempt_id: number | null; course_id: number | null
}
export type QuizAttempt = { id: number; started_at: string; finished_at: string | null; current_question: number; answers: number[]; score: number | null; passed: boolean | null }
```
и методы:
```ts
  learning: {
    courses: {
      list: (includeArchived = true) => request<Course[]>('GET', `/api/learning/courses${includeArchived ? '?includeArchived=1' : ''}`),
      get: (id: number) => request<CourseDetails>('GET', `/api/learning/courses/${id}`),
      create: (body: CourseBody) => request<CourseDetails>('POST', '/api/learning/courses', body),
      update: (id: number, body: CourseBody) => request<CourseDetails>('PATCH', `/api/learning/courses/${id}`, body),
      publish: (id: number, assignExisting: boolean) => request<{ course: Course; assigned: number }>('POST', `/api/learning/courses/${id}/publish`, { assign_existing: assignExisting }),
      archive: (id: number) => request<Course>('POST', `/api/learning/courses/${id}/archive`),
    },
    quizzes: {
      list: (includeArchived = true) => request<Quiz[]>('GET', `/api/learning/quizzes${includeArchived ? '?includeArchived=1' : ''}`),
      get: (id: number) => request<{ quiz: Quiz; questions: Question[] }>('GET', `/api/learning/quizzes/${id}`),
      create: (body: QuizBody) => request<{ quiz: Quiz; questions: Question[] }>('POST', '/api/learning/quizzes', body),
      update: (id: number, body: QuizBody) => request<{ quiz: Quiz; questions: Question[] }>('PATCH', `/api/learning/quizzes/${id}`, body),
      publish: (id: number) => request<Quiz>('POST', `/api/learning/quizzes/${id}/publish`),
      issue: (id: number) => request<{ assigned: number }>('POST', `/api/learning/quizzes/${id}/issue`),
      archive: (id: number) => request<Quiz>('POST', `/api/learning/quizzes/${id}/archive`),
    },
    assignments: {
      courses: (f: { course_id?: number; employee_id?: number; status?: string }) => request<CourseAssignmentRow[]>('GET', `/api/learning/assignments/courses${qs(f)}`),
      quizzes: (f: { quiz_id?: number; employee_id?: number; status?: string }) => request<QuizAssignmentRow[]>('GET', `/api/learning/assignments/quizzes${qs(f)}`),
      attempts: (id: number) => request<QuizAttempt[]>('GET', `/api/learning/assignments/quizzes/${id}/attempts`),
    },
    upload: async (file: File) => {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
      return request<{ path: string }>('POST', '/api/learning/upload', { filename: file.name, mime: file.type, data })
    },
  },
```
В `errorText` добавить обработку `issues` из тела 409 `incomplete`: если `err.body?.issues` — массив строк, вернуть их через «. » (тип `issues?: ({ message: string } | string)[]`, строки брать как есть).

- [ ] **Step 2: Роутер и шапка**

`admin/src/router.ts` children +=:
```ts
        { path: 'learning/courses', component: CoursesPage },
        { path: 'learning/courses/new', component: CourseForm },
        { path: 'learning/courses/:id/edit', component: CourseForm, props: true },
        { path: 'learning/quizzes', component: QuizzesPage },
        { path: 'learning/quizzes/new', component: QuizForm },
        { path: 'learning/quizzes/:id/edit', component: QuizForm, props: true },
        { path: 'learning/progress', component: ProgressPage },
```
`AppLayout.vue` после «Проверка фото»:
```vue
        <RouterLink to="/learning/courses" class="text-sm hover:underline" active-class="font-semibold">Курсы</RouterLink>
        <RouterLink to="/learning/quizzes" class="text-sm hover:underline" active-class="font-semibold">Тесты</RouterLink>
        <RouterLink to="/learning/progress" class="text-sm hover:underline" active-class="font-semibold">Прогресс</RouterLink>
```
(если шапка перестаёт помещаться в одну строку, обернуть `nav` в `flex-wrap` и высоту `h-14` заменить на `py-2`).

- [ ] **Step 3: QuestionsEditor.vue**

```vue
<script setup lang="ts">
import type { Question } from '../api'

const props = defineProps<{ modelValue: Question[] }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: Question[]): void }>()

function update(fn: (list: Question[]) => void) {
  const copy = props.modelValue.map((q) => ({ ...q, options: [...q.options] }))
  fn(copy)
  emit('update:modelValue', copy)
}
const add = () => update((l) => l.push({ text: '', options: ['', ''], correct_index: 0 }))
const remove = (i: number) => update((l) => l.splice(i, 1))
const addOption = (i: number) => update((l) => { if (l[i]!.options.length < 5) l[i]!.options.push('') })
const removeOption = (i: number, j: number) =>
  update((l) => {
    const q = l[i]!
    if (q.options.length <= 2) return
    q.options.splice(j, 1)
    if (q.correct_index >= q.options.length) q.correct_index = 0
  })
</script>

<template>
  <div class="space-y-3">
    <div v-for="(q, i) in modelValue" :key="i" class="border rounded-lg p-3 space-y-2">
      <div class="flex gap-2">
        <input :value="q.text" class="input" placeholder="Текст вопроса" @input="update((l) => (l[i]!.text = ($event.target as HTMLInputElement).value))" />
        <button type="button" class="btn-secondary" @click="remove(i)">Убрать</button>
      </div>
      <div v-for="(o, j) in q.options" :key="j" class="flex gap-2 items-center">
        <input type="radio" :name="`correct-${i}`" :checked="q.correct_index === j" title="Правильный ответ" @change="update((l) => (l[i]!.correct_index = j))" />
        <input :value="o" class="input" placeholder="Вариант ответа" @input="update((l) => (l[i]!.options[j] = ($event.target as HTMLInputElement).value))" />
        <button v-if="q.options.length > 2" type="button" class="btn-secondary" @click="removeOption(i, j)">×</button>
      </div>
      <button v-if="q.options.length < 5" type="button" class="btn-secondary" @click="addOption(i)">+ вариант</button>
    </div>
    <button type="button" class="btn-secondary" @click="add">+ вопрос</button>
    <p class="text-xs text-gray-500">Отметьте правильный ответ переключателем слева.</p>
  </div>
</template>
```

- [ ] **Step 4: CoursesPage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Course, type Position } from '../api'

const courses = ref<Course[]>([])
const positions = ref<Position[]>([])
const error = ref('')
const STATUS: Record<Course['status'], string> = { draft: 'Черновик', published: 'Опубликован', archived: 'В архиве' }

async function load() {
  try {
    ;[courses.value, positions.value] = await Promise.all([api.learning.courses.list(true), api.positions.list()])
  } catch (err) {
    error.value = errorText(err)
  }
}
const positionNames = (ids: number[]) => ids.map((id) => positions.value.find((p) => p.id === id)?.name ?? '?').join(', ')

async function publish(c: Course) {
  const assignExisting = window.confirm(`Назначить курс «${c.title}» всем текущим сотрудникам выбранных должностей?\nОК — всем текущим, Отмена — только новым.`)
  error.value = ''
  try {
    const r = await api.learning.courses.publish(c.id, assignExisting)
    window.alert(`Опубликовано. Назначено сотрудникам: ${r.assigned}`)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function archive(c: Course) {
  if (!window.confirm(`Отправить курс «${c.title}» в архив? Начатые назначения останутся.`)) return
  error.value = ''
  try {
    await api.learning.courses.archive(c.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Курсы</h1>
      <RouterLink to="/learning/courses/new" class="btn ml-auto">Новый курс</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr><th class="px-4 py-2">Название</th><th class="px-4 py-2">Должности</th><th class="px-4 py-2">Уроков</th><th class="px-4 py-2">Срок, дней</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="c in courses" :key="c.id" :class="{ 'text-gray-400': c.status === 'archived' }">
          <td class="px-4 py-2">{{ c.title }}</td>
          <td class="px-4 py-2">{{ positionNames(c.position_ids) || '—' }}</td>
          <td class="px-4 py-2">{{ c.lesson_count }}</td>
          <td class="px-4 py-2">{{ c.due_days }}</td>
          <td class="px-4 py-2">{{ STATUS[c.status] }}</td>
          <td class="px-4 py-2 text-right space-x-2 whitespace-nowrap">
            <RouterLink :to="`/learning/courses/${c.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button v-if="c.status !== 'published'" class="btn-secondary" @click="publish(c)">Опубликовать</button>
            <button v-if="c.status !== 'archived'" class="btn-secondary" @click="archive(c)">В архив</button>
          </td>
        </tr>
        <tr v-if="courses.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Пока пусто</td></tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 5: CourseForm.vue**

```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type CourseBody, type Lesson, type Position, type Question } from '../api'
import QuestionsEditor from '../components/QuestionsEditor.vue'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)
const positions = ref<Position[]>([])
const error = ref('')
const busy = ref(false)
const form = reactive<CourseBody>({ title: '', description: '', due_days: 7, pass_score: 80, position_ids: [], lessons: [], questions: [] })
const videoDraft = ref<Record<number, string>>({})

async function load() {
  positions.value = await api.positions.list()
  if (!props.id) return
  const d = await api.learning.courses.get(Number(props.id))
  Object.assign(form, {
    title: d.course.title, description: d.course.description, due_days: d.course.due_days, pass_score: d.course.pass_score,
    position_ids: d.course.position_ids, lessons: d.lessons.map((l) => ({ title: l.title, body: l.body, media: [...l.media] })), questions: d.questions.map((q) => ({ text: q.text, options: [...q.options], correct_index: q.correct_index })),
  })
}

const addLesson = () => form.lessons.push({ title: '', body: '', media: [] })
const removeLesson = (i: number) => form.lessons.splice(i, 1)
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= form.lessons.length) return
  const [l] = form.lessons.splice(i, 1)
  form.lessons.splice(j, 0, l as Lesson)
}
async function addImage(i: number, ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  try {
    const { path } = await api.learning.upload(file)
    form.lessons[i]!.media.push({ kind: 'image', path })
  } catch (err) {
    error.value = errorText(err, { validation: 'Картинка jpg, png или webp до 5 МБ.' })
  } finally {
    input.value = ''
  }
}
function addVideo(i: number) {
  const url = (videoDraft.value[i] ?? '').trim()
  if (!url) return
  form.lessons[i]!.media.push({ kind: 'video', url })
  videoDraft.value[i] = ''
}
const removeMedia = (i: number, j: number) => form.lessons[i]!.media.splice(j, 1)
const setQuestions = (q: Question[]) => (form.questions = q)

async function save() {
  busy.value = true
  error.value = ''
  try {
    const body: CourseBody = { ...form, due_days: Number(form.due_days), pass_score: Number(form.pass_score) }
    if (editing.value) await api.learning.courses.update(Number(props.id), body)
    else await api.learning.courses.create(body)
    await router.push('/learning/courses')
  } catch (err) {
    error.value = errorText(err, { invalid_reference: 'Выбранная должность не существует.' })
  } finally {
    busy.value = false
  }
}

onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-3xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Курс' : 'Новый курс' }}</h1>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <label class="block text-sm">Описание<textarea v-model="form.description" class="input mt-1" rows="2" /></label>
      <div class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1"><input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}</label>
      </div>
      <div class="flex gap-4 text-sm">
        <label>Срок, дней<input v-model.number="form.due_days" type="number" min="1" max="365" class="input mt-1 max-w-32" required /></label>
        <label>Проходной балл<input v-model.number="form.pass_score" type="number" min="0" max="100" class="input mt-1 max-w-32" required /></label>
      </div>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-4">
      <div class="text-sm font-medium">Уроки</div>
      <div v-for="(l, i) in form.lessons" :key="i" class="border rounded-lg p-3 space-y-2">
        <div class="flex gap-2 items-center">
          <span class="text-sm text-gray-500 w-6">{{ i + 1 }}.</span>
          <input v-model="l.title" class="input" placeholder="Заголовок урока" required />
          <button type="button" class="btn-secondary" @click="move(i, -1)">↑</button>
          <button type="button" class="btn-secondary" @click="move(i, 1)">↓</button>
          <button type="button" class="btn-secondary" @click="removeLesson(i)">Убрать</button>
        </div>
        <textarea v-model="l.body" class="input" rows="4" placeholder="Текст урока" />
        <div class="flex flex-wrap gap-2 items-center text-sm">
          <template v-for="(m, j) in l.media" :key="j">
            <span class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1">
              <img v-if="m.kind === 'image'" :src="`/api/uploads/${m.path}`" alt="картинка урока" class="h-8 rounded" />
              <span v-else class="truncate max-w-48">{{ m.url }}</span>
              <button type="button" class="text-gray-500" @click="removeMedia(i, j)">×</button>
            </span>
          </template>
        </div>
        <div class="flex flex-wrap gap-2 items-center text-sm">
          <label class="btn-secondary cursor-pointer">Добавить картинку<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="addImage(i, $event)" /></label>
          <input v-model="videoDraft[i]" class="input max-w-72" placeholder="Ссылка на видео (YouTube и т.п.)" />
          <button type="button" class="btn-secondary" @click="addVideo(i)">Добавить видео</button>
        </div>
      </div>
      <button type="button" class="btn-secondary" @click="addLesson">+ урок</button>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Итоговый тест</div>
      <QuestionsEditor :model-value="form.questions" @update:model-value="setQuestions" />
    </section>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">Сохранить</button>
      <RouterLink to="/learning/courses" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
```

- [ ] **Step 6: QuizzesPage.vue и QuizForm.vue**

`QuizzesPage.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Position, type Quiz } from '../api'
import { describeSchedule } from '../lib/schedule'

const quizzes = ref<Quiz[]>([])
const positions = ref<Position[]>([])
const error = ref('')
const STATUS: Record<Quiz['status'], string> = { draft: 'Черновик', published: 'Опубликован', archived: 'В архиве' }

async function load() {
  try {
    ;[quizzes.value, positions.value] = await Promise.all([api.learning.quizzes.list(true), api.positions.list()])
  } catch (err) {
    error.value = errorText(err)
  }
}
const positionNames = (ids: number[]) => ids.map((id) => positions.value.find((p) => p.id === id)?.name ?? '?').join(', ')
async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try {
    await fn()
    await load()
  } catch (err) {
    error.value = errorText(err, { not_published: 'Сначала опубликуйте тест.' })
  }
}
const publish = (q: Quiz) => run(() => api.learning.quizzes.publish(q.id))
const issue = (q: Quiz) => run(async () => { const r = await api.learning.quizzes.issue(q.id); window.alert(`Выдано сотрудникам: ${r.assigned}`) })
const archive = (q: Quiz) => { if (window.confirm(`Отправить тест «${q.title}» в архив?`)) void run(() => api.learning.quizzes.archive(q.id)) }
onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-4">
      <h1 class="text-xl font-semibold">Тесты</h1>
      <RouterLink to="/learning/quizzes/new" class="btn ml-auto">Новый тест</RouterLink>
    </div>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr><th class="px-4 py-2">Название</th><th class="px-4 py-2">Должности</th><th class="px-4 py-2">Расписание</th><th class="px-4 py-2">Вопросов</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="q in quizzes" :key="q.id" :class="{ 'text-gray-400': q.status === 'archived' }">
          <td class="px-4 py-2">{{ q.title }}</td>
          <td class="px-4 py-2">{{ positionNames(q.position_ids) || '—' }}</td>
          <td class="px-4 py-2">{{ q.schedule ? describeSchedule(q.schedule) : 'Без расписания' }}</td>
          <td class="px-4 py-2">{{ q.question_count }}</td>
          <td class="px-4 py-2">{{ STATUS[q.status] }}</td>
          <td class="px-4 py-2 text-right space-x-2 whitespace-nowrap">
            <RouterLink :to="`/learning/quizzes/${q.id}/edit`" class="btn-secondary">Изменить</RouterLink>
            <button v-if="q.status !== 'published'" class="btn-secondary" @click="publish(q)">Опубликовать</button>
            <button v-if="q.status === 'published'" class="btn-secondary" @click="issue(q)">Выдать сейчас</button>
            <button v-if="q.status !== 'archived'" class="btn-secondary" @click="archive(q)">В архив</button>
          </td>
        </tr>
        <tr v-if="quizzes.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Пока пусто</td></tr>
      </tbody>
    </table>
  </div>
</template>
```

`QuizForm.vue`:
```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type Position, type Question, type QuizBody } from '../api'
import QuestionsEditor from '../components/QuestionsEditor.vue'
import { DAY_LABELS } from '../lib/schedule'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)
const positions = ref<Position[]>([])
const error = ref('')
const busy = ref(false)
const form = reactive({
  title: '', pass_score: 80, position_ids: [] as number[], scheduled: false, days: [1] as number[], times: ['10:00'] as string[],
  deadline_minutes: 480, questions: [] as Question[],
})

async function load() {
  positions.value = await api.positions.list()
  if (!props.id) return
  const d = await api.learning.quizzes.get(Number(props.id))
  Object.assign(form, {
    title: d.quiz.title, pass_score: d.quiz.pass_score, position_ids: d.quiz.position_ids, scheduled: d.quiz.schedule !== null,
    deadline_minutes: d.quiz.deadline_minutes ?? 480, questions: d.questions.map((q) => ({ text: q.text, options: [...q.options], correct_index: q.correct_index })),
  })
  if (d.quiz.schedule?.kind === 'weekly') { form.days = d.quiz.schedule.days; form.times = d.quiz.schedule.times }
}
const toggleDay = (d: number) => (form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d])
const setQuestions = (q: Question[]) => (form.questions = q)

async function save() {
  busy.value = true
  error.value = ''
  try {
    const body: QuizBody = {
      title: form.title, pass_score: Number(form.pass_score), position_ids: form.position_ids,
      schedule: form.scheduled ? { kind: 'weekly', days: form.days, times: form.times.filter(Boolean) } : null,
      deadline_minutes: Number(form.deadline_minutes), questions: form.questions,
    }
    if (editing.value) await api.learning.quizzes.update(Number(props.id), body)
    else await api.learning.quizzes.create(body)
    await router.push('/learning/quizzes')
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}
onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-3xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Тест' : 'Новый тест' }}</h1>
    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <div class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1"><input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}</label>
      </div>
      <div class="flex gap-4 text-sm">
        <label>Проходной балл<input v-model.number="form.pass_score" type="number" min="0" max="100" class="input mt-1 max-w-32" required /></label>
        <label>Срок на прохождение, минут<input v-model.number="form.deadline_minutes" type="number" min="15" class="input mt-1 max-w-32" required /></label>
      </div>
      <label class="flex items-center gap-2 text-sm"><input v-model="form.scheduled" type="checkbox" /> Выдавать по расписанию</label>
      <template v-if="form.scheduled">
        <div class="flex gap-1">
          <button v-for="(label, i) in DAY_LABELS" :key="i" type="button" class="btn-secondary" :class="{ 'bg-gray-900 text-white': form.days.includes(i + 1) }" @click="toggleDay(i + 1)">{{ label }}</button>
        </div>
        <div class="space-y-2">
          <div v-for="(_, i) in form.times" :key="i" class="flex gap-2 items-center">
            <input v-model="form.times[i]" type="time" class="input max-w-40" required />
            <button v-if="form.times.length > 1" type="button" class="btn-secondary" @click="form.times.splice(i, 1)">Убрать</button>
          </div>
          <button type="button" class="btn-secondary" @click="form.times.push('12:00')">+ время</button>
        </div>
      </template>
    </section>
    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Вопросы</div>
      <QuestionsEditor :model-value="form.questions" @update:model-value="setQuestions" />
    </section>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">Сохранить</button>
      <RouterLink to="/learning/quizzes" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
```

- [ ] **Step 7: ProgressPage.vue**

```vue
<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { api, errorText, type Course, type CourseAssignmentRow, type Employee, type Quiz, type QuizAssignmentRow, type QuizAttempt } from '../api'
import { fmtDate } from '../lib/schedule'

const tab = ref<'courses' | 'quizzes'>('courses')
const courses = ref<Course[]>([])
const quizzes = ref<Quiz[]>([])
const employees = ref<Employee[]>([])
const courseRows = ref<CourseAssignmentRow[]>([])
const quizRows = ref<QuizAssignmentRow[]>([])
const attempts = ref<Record<number, QuizAttempt[]>>({})
const error = ref('')
const filters = reactive({ employee_id: '' as number | '', course_id: '' as number | '', quiz_id: '' as number | '', status: '' })
const COURSE_STATUS: Record<string, string> = { in_progress: 'В процессе', completed: 'Завершён', overdue: 'Просрочен' }
const QUIZ_STATUS: Record<string, string> = { pending: 'Не сдан', passed: 'Сдан', overdue: 'Просрочен' }

async function load() {
  error.value = ''
  try {
    if (tab.value === 'courses') {
      courseRows.value = await api.learning.assignments.courses({ employee_id: filters.employee_id || undefined, course_id: filters.course_id || undefined, status: filters.status || undefined })
    } else {
      quizRows.value = await api.learning.assignments.quizzes({ employee_id: filters.employee_id || undefined, quiz_id: filters.quiz_id || undefined, status: filters.status || undefined })
    }
  } catch (err) {
    error.value = errorText(err)
  }
}
async function toggleAttempts(row: QuizAssignmentRow) {
  if (attempts.value[row.id]) { delete attempts.value[row.id]; return }
  try {
    attempts.value[row.id] = await api.learning.assignments.attempts(row.id)
  } catch (err) {
    error.value = errorText(err)
  }
}
onMounted(async () => {
  try {
    ;[courses.value, quizzes.value, employees.value] = await Promise.all([api.learning.courses.list(true), api.learning.quizzes.list(true), api.employees.list(true)])
  } catch (err) {
    error.value = errorText(err)
  }
  await load()
})
watch([tab, filters], () => { filters.status = ''; void load() }, { deep: true })
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Прогресс обучения</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'courses' }" @click="tab = 'courses'">Курсы</button>
      <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'quizzes' }" @click="tab = 'quizzes'">Тесты</button>
      <select v-model="filters.employee_id" class="input max-w-56"><option value="">Все сотрудники</option><option v-for="e in employees" :key="e.id" :value="e.id">{{ e.full_name }}</option></select>
      <select v-if="tab === 'courses'" v-model="filters.course_id" class="input max-w-64"><option value="">Все курсы</option><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
      <select v-else v-model="filters.quiz_id" class="input max-w-64"><option value="">Все тесты</option><option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option></select>
    </div>

    <table v-if="tab === 'courses'" class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Курс</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Урок</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th></tr></thead>
      <tbody class="divide-y">
        <tr v-for="r in courseRows" :key="r.id" :class="{ 'text-red-700': r.status === 'overdue' }">
          <td class="px-4 py-2">{{ r.title }}</td><td class="px-4 py-2">{{ r.employee_name }}</td>
          <td class="px-4 py-2">{{ Math.min(r.current_lesson, r.lesson_count) }} из {{ r.lesson_count }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td><td class="px-4 py-2">{{ COURSE_STATUS[r.status] }}</td>
        </tr>
        <tr v-if="courseRows.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>

    <table v-else class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Тест</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr></thead>
      <tbody class="divide-y">
        <template v-for="r in quizRows" :key="r.id">
          <tr :class="{ 'text-red-700': r.status === 'overdue' }">
            <td class="px-4 py-2">{{ r.title }}</td><td class="px-4 py-2">{{ r.employee_name }}</td>
            <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td><td class="px-4 py-2">{{ QUIZ_STATUS[r.status] }}</td>
            <td class="px-4 py-2 text-right"><button class="btn-secondary" @click="toggleAttempts(r)">Попытки</button></td>
          </tr>
          <tr v-if="attempts[r.id]"><td colspan="5" class="px-4 py-2 bg-gray-50">
            <span v-if="attempts[r.id]!.length === 0" class="text-gray-500">Попыток пока нет</span>
            <ul v-else class="space-y-1">
              <li v-for="a in attempts[r.id]" :key="a.id">{{ fmtDate(a.started_at) }}: {{ a.finished_at ? `${a.score} из 100, ${a.passed ? 'сдано' : 'не сдано'}` : `в процессе, вопрос ${a.current_question}` }}</li>
            </ul>
          </td></tr>
        </template>
        <tr v-if="quizRows.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 8: Сборка и commit**

Run: `npm run build` → Vite и tsc чисто. Run: `npm test` → зелёные.

```bash
git add admin
git commit -m "feat(admin): courses, quizzes and learning progress pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Сквозной тест, README, ручной прогон

**Files:**
- Create: `server/bot/learning.e2e.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Сквозной тест**

`server/bot/learning.e2e.test.ts`:
```ts
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
```

Run: `npx vitest run server/bot/learning.e2e.test.ts` → 1 passed.

- [ ] **Step 2: README**

В раздел «Что умеет» добавить:
```markdown
- Обучение: курсы по должностям (уроки с текстом, картинками и ссылками на видео, итоговый тест), автоназначение новым сотрудникам, отдельные тесты по расписанию, пересдачи без ограничений, прогресс и попытки в админке.
```
В строку про дизайн добавить ссылку на `docs/superpowers/specs/2026-09-08-stage3-learning-design.md`.

- [ ] **Step 3: Ручной прогон**

Запустить сборку и сервер (`npm run build`, затем `set -a; source .env; set +a; npm start`) и пройти:
1. Админка → Курсы → Новый курс «Эспрессо по стандарту»: должность, 2 урока (во втором картинка с загрузкой и ссылка на видео), 2 вопроса → Сохранить → Опубликовать → «всем текущим» → «Назначено: N».
2. В боте у сотрудника пришло «Новый курс»; «Обучение» → «Продолжить» → уроки с картинкой и превью видео → «Прочитал, дальше» → «Пройти тест» → вопросы → провал → «Пересдать» → сдача; владельцу пришло «прошёл курс».
3. Тесты → Новый тест «Меню недели» по понедельникам в 10:00, срок 480 минут → Опубликовать → «Выдать сейчас» → сотруднику пришёл «Новый тест»; Прогресс показывает назначения и попытки.
4. Планировщик: добавить нового сотрудника с должностью курса и привязать его вторым аккаунтом → в течение минуты приходит «Новый курс» (курс опубликован с «всем текущим» или создан после публикации).

Без второго Telegram-аккаунта пункты 2 и 4 не проверить, отметьте это в отчёте.

- [ ] **Step 4: Финальная проверка и commit**

Run: `npm test && npm run typecheck && npm run build` → зелёные.

```bash
git add -A
git commit -m "test: learning end-to-end flow; document stage 3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
