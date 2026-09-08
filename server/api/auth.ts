import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { SESSION_TTL_MS, type OwnerAuth } from '../auth/ownerAuth.js'
import type { Db } from '../db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'
import { parse } from '../lib/validate.js'
import type { Notifier } from '../notify.js'
import { requireOwner, SESSION_COOKIE, sessionToken } from './requireOwner.js'

type Opts = {
  db: Db
  auth: OwnerAuth
  notifier: Notifier
  secureCookie: boolean
}

const verifyBody = z.object({ code: z.string().regex(/^\d{6}$/) })

export const authRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, auth, notifier, secureCookie } = opts

  app.post('/api/auth/request-code', async (_req, reply) => {
    if (!getSetting(db, OWNER_TELEGRAM_ID)) {
      return reply.code(409).send({ error: 'owner_not_linked' })
    }
    const code = auth.createLoginCode()
    if (code === 'locked') return reply.code(429).send({ error: 'locked' })
    await notifier.toOwner(`Код входа в админку: ${code}\nДействует 5 минут.`)
    return reply.code(204).send()
  })

  app.post('/api/auth/verify', async (req, reply) => {
    const { code } = parse(verifyBody, req.body)
    const result = auth.verifyLoginCode(code)
    if ('error' in result) {
      return reply.code(result.error === 'locked' ? 429 : 401).send({ error: result.error })
    }
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      signed: true,
    })
    return reply.code(204).send()
  })

  app.post('/api/auth/logout', { preHandler: requireOwner(auth) }, async (req, reply) => {
    const token = sessionToken(req)
    if (token) auth.deleteSession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: requireOwner(auth) }, async () => ({ ok: true }))
}
