import { Bot, type Api } from 'grammy'
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

export type ApiCall = { method: string; payload: Record<string, unknown> }
type Responder = (payload: Record<string, unknown>) => unknown

let messageCounter = 100

export function captureApi(
  target: Api | Bot,
  responders: Record<string, Responder> = {},
  calls: ApiCall[] = [],
): ApiCall[] {
  const api = target instanceof Bot ? target.api : target
  api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>
    calls.push({ method, payload: p })
    const custom = responders[method]
    if (custom) return { ok: true, result: custom(p) }
    if (method === 'sendMessage' || method === 'sendPhoto') {
      return { ok: true, result: { message_id: ++messageCounter } }
    }
    if (method === 'sendMediaGroup') return { ok: true, result: [] }
    return { ok: true, result: true }
  })
  return calls
}

export function photoUpdate(fromId: number, fileId: string, uniqueId: string): Update {
  return {
    update_id: ++updateId,
    message: {
      ...base(fromId, 'User'),
      photo: [
        { file_id: `${fileId}-s`, file_unique_id: `${uniqueId}-s`, width: 90, height: 90 },
        { file_id: fileId, file_unique_id: uniqueId, width: 1280, height: 960 },
      ],
    },
  }
}

export function callbackUpdate(fromId: number, data: string, messageId = 1): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: { id: fromId, is_bot: false, first_name: 'User' },
      chat_instance: 'ci',
      data,
      message: { ...base(fromId, 'User'), message_id: messageId, text: 'x' },
    },
  }
}
