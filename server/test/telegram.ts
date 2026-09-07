import type { Bot } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'

export const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

let updateId = 0

function base(fromId: number, name: string) {
  return {
    message_id: ++updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: 'private' as const, first_name: name },
    from: { id: fromId, is_bot: false, first_name: name },
  }
}

export function textUpdate(fromId: number, text: string, name = 'User'): Update {
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }]
    : []
  return { update_id: ++updateId, message: { ...base(fromId, name), text, entities } }
}

export function contactUpdate(fromId: number, phone: string, contactUserId = fromId): Update {
  return {
    update_id: ++updateId,
    message: {
      ...base(fromId, 'User'),
      contact: { phone_number: phone, first_name: 'User', user_id: contactUserId },
    },
  }
}

export function captureApi(bot: Bot) {
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true }
  })
  return calls
}
