import { InputFile, InputMediaBuilder, type Api, type InlineKeyboard } from 'grammy'
import type { Db } from './db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from './db/settings.js'

export type SendExtra = { keyboard?: InlineKeyboard }

export type Notifier = {
  toOwner(text: string, extra?: SendExtra): Promise<number | null>
  toEmployee(telegramId: number, text: string, extra?: SendExtra): Promise<number | null>
  photosToOwner(paths: string[], caption: string, keyboard?: InlineKeyboard): Promise<boolean>
  editMessage(chatId: number, messageId: number, text: string): Promise<boolean>
}

export function createTelegramNotifier(api: Api, db: Db): Notifier {
  const ownerId = (): number | null => {
    const v = getSetting(db, OWNER_TELEGRAM_ID)
    return v ? Number(v) : null
  }

  async function send(chatId: number, text: string, extra?: SendExtra): Promise<number | null> {
    try {
      const msg = await api.sendMessage(chatId, text, {
        reply_markup: extra?.keyboard,
      })
      return msg.message_id
    } catch (err) {
      console.error('notify failed', chatId, err)
      return null
    }
  }

  return {
    toOwner(text, extra) {
      const id = ownerId()
      return id ? send(id, text, extra) : Promise.resolve(null)
    },
    toEmployee: send,
    async photosToOwner(paths, caption, keyboard) {
      const id = ownerId()
      if (!id || paths.length === 0) return false
      try {
        if (paths.length === 1) {
          await api.sendPhoto(id, new InputFile(paths[0]!), { caption, reply_markup: keyboard })
          return true
        }
        await api.sendMediaGroup(id, paths.map((p) => InputMediaBuilder.photo(new InputFile(p))))
        await api.sendMessage(id, caption, { reply_markup: keyboard })
        return true
      } catch (err) {
        console.error('photosToOwner failed', err)
        return false
      }
    },
    async editMessage(chatId, messageId, text) {
      try {
        await api.editMessageText(chatId, messageId, text)
        return true
      } catch {
        return false
      }
    },
  }
}
