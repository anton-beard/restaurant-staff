import type { Bot, Context } from 'grammy'
import { findEmployeeByPhone, findEmployeeByTelegramId, linkTelegram } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { normalizePhone } from '../lib/phone.js'
import type { BotDeps } from './deps.js'
import { BTN, contactRequest, employeeMenu, ownerMenu } from './keyboards.js'
import { roleOf, summaryText } from './roles.js'
import type { BotContext } from './states.js'

export async function showHome(ctx: Context, deps: BotDeps): Promise<void> {
  if (!ctx.from) return
  const role = roleOf(deps.db, ctx.from.id)
  if (role.kind === 'owner') {
    await ctx.reply(`Вы владелец.\n${summaryText(deps.db, deps.publicUrl, deps.now())}`, { reply_markup: ownerMenu() })
  } else if (role.kind === 'employee') {
    await ctx.reply(`Здравствуйте, ${role.employee.full_name}!`, { reply_markup: employeeMenu() })
  } else {
    await ctx.reply('Чтобы подключиться, поделитесь номером телефона.', { reply_markup: contactRequest() })
  }
}

export function registerLinking(bot: Bot<BotContext>, deps: BotDeps): void {
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
      await ctx.reply(`Вы вошли как владелец.\n${summaryText(db, deps.publicUrl, deps.now())}`, { reply_markup: ownerMenu() })
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
    await ctx.reply(summaryText(db, deps.publicUrl, deps.now()), { reply_markup: ownerMenu() })
  })
}

export function registerFallback(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.on('message', (ctx) => showHome(ctx, deps))
}
