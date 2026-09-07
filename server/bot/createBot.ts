import { Bot, type Context } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import type { Db } from '../db/connect.js'
import {
  findEmployeeByPhone,
  findEmployeeByTelegramId,
  linkTelegram,
  listEmployees,
  type Employee,
} from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { normalizePhone } from '../lib/phone.js'
import { notifyOwner } from '../notify.js'
import { BTN, contactRequest, employeeMenu, ownerMenu } from './keyboards.js'

export type BotOptions = {
  token: string
  db: Db
  ownerPhone: string
  publicUrl?: string
  botInfo?: UserFromGetMe
}

type Role = { kind: 'owner' } | { kind: 'employee'; employee: Employee } | { kind: 'unknown' }

export function createBot(opts: BotOptions): Bot {
  const { db, publicUrl } = opts
  const ownerPhone = normalizePhone(opts.ownerPhone)
  if (!ownerPhone) throw new Error('OWNER_PHONE is not a valid phone number')

  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined)

  function roleOf(telegramId: number): Role {
    if (getSetting(db, OWNER_TELEGRAM_ID) === String(telegramId)) return { kind: 'owner' }
    const employee = findEmployeeByTelegramId(db, telegramId)
    if (employee && employee.status === 'active') return { kind: 'employee', employee }
    return { kind: 'unknown' }
  }

  function summaryText(): string {
    const all = listEmployees(db)
    const active = all.filter((e) => e.status === 'active').length
    const invited = all.filter((e) => e.status === 'invited').length
    const lines = [`Активны: ${active}`, `Приглашены: ${invited}`]
    if (publicUrl) lines.push(`Админка: ${publicUrl}`)
    return lines.join('\n')
  }

  async function showHome(ctx: Context): Promise<void> {
    if (!ctx.from) return
    const role = roleOf(ctx.from.id)
    if (role.kind === 'owner') {
      await ctx.reply(`Вы владелец.\n${summaryText()}`, { reply_markup: ownerMenu() })
    } else if (role.kind === 'employee') {
      await ctx.reply(`Здравствуйте, ${role.employee.full_name}!`, { reply_markup: employeeMenu() })
    } else {
      await ctx.reply('Чтобы подключиться, поделитесь номером телефона.', {
        reply_markup: contactRequest(),
      })
    }
  }

  bot.command('start', showHome)

  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact
    const fromId = ctx.from.id
    if (contact.user_id !== fromId) {
      await ctx.reply('Пришлите свой номер через кнопку «Поделиться номером».', {
        reply_markup: contactRequest(),
      })
      return
    }
    const phone = normalizePhone(contact.phone_number)
    if (!phone) {
      await ctx.reply('Не удалось распознать номер. Обратитесь к владельцу.')
      return
    }
    if (phone === ownerPhone) {
      const previous = getSetting(db, OWNER_TELEGRAM_ID)
      if (previous && previous !== String(fromId)) {
        console.warn(`owner telegram id changed from ${previous} to ${fromId}`)
      }
      setSetting(db, OWNER_TELEGRAM_ID, String(fromId))
      await ctx.reply(`Вы вошли как владелец.\n${summaryText()}`, { reply_markup: ownerMenu() })
      return
    }
    const employee = findEmployeeByPhone(db, phone)
    if (!employee || employee.status === 'archived') {
      await ctx.reply('Вас ещё не добавили. Обратитесь к владельцу.')
      return
    }
    if (employee.status === 'active') {
      if (employee.telegram_id === fromId) return showHome(ctx)
      await ctx.reply('Этот номер уже привязан к другому аккаунту Telegram.')
      return
    }
    const alreadyLinked = findEmployeeByTelegramId(db, fromId)
    if (alreadyLinked && alreadyLinked.id !== employee.id) {
      await ctx.reply('Ваш Telegram уже привязан к другому сотруднику. Обратитесь к владельцу.')
      return
    }
    const linked = linkTelegram(db, employee.id, fromId)!
    await ctx.reply(`Здравствуйте, ${linked.full_name}! Вы подключены.`, {
      reply_markup: employeeMenu(),
    })
    await notifyOwner(ctx.api, db, `Сотрудник ${linked.full_name} подключился к боту.`)
  })

  bot.hears([BTN.tasks, BTN.learning, BTN.quizzes, BTN.rating], async (ctx) => {
    if (!ctx.from) return
    if (roleOf(ctx.from.id).kind !== 'employee') return showHome(ctx)
    await ctx.reply('Раздел появится в ближайшем обновлении.')
  })

  bot.hears(BTN.summary, async (ctx) => {
    if (!ctx.from) return
    if (roleOf(ctx.from.id).kind !== 'owner') return showHome(ctx)
    await ctx.reply(summaryText(), { reply_markup: ownerMenu() })
  })

  bot.on('message', showHome)

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
