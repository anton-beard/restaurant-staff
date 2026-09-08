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
