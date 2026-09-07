import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OwnerAuth } from '../auth/ownerAuth.js'

export const SESSION_COOKIE = 'session'

export function sessionToken(req: FastifyRequest): string | undefined {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return undefined
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid ? unsigned.value : undefined
}

export function requireOwner(auth: OwnerAuth) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth.hasSession(sessionToken(req))) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }
}
