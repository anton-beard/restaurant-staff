import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import type { Config } from './config.js'
import type { Db } from './db/connect.js'
import type { OwnerAuth } from './auth/ownerAuth.js'
import { ValidationError } from './lib/validate.js'
import { authRoutes } from './api/auth.js'
import { requireOwner } from './api/requireOwner.js'
import { positionRoutes } from './api/positions.js'
import { employeeRoutes } from './api/employees.js'

export type AppDeps = {
  config: Config
  db: Db
  auth: OwnerAuth
  sendToOwner: (text: string) => Promise<boolean>
  adminDistDir?: string
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, auth, sendToOwner } = deps
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.register(fastifyCookie, { secret: config.SESSION_SECRET })

  app.setErrorHandler<FastifyError | ValidationError>((err, _req, reply) => {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ error: 'validation', issues: err.issues })
    }
    const code = (err as { code?: string }).code ?? ''
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return reply.code(409).send({ error: 'conflict' })
    }
    app.log.error(err)
    return reply.code(err.statusCode ?? 500).send({ error: 'internal' })
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.register(authRoutes, {
    db,
    auth,
    sendToOwner,
    secureCookie: config.PUBLIC_URL?.startsWith('https://') ?? false,
  })

  app.register(async (scope) => {
    scope.addHook('preHandler', requireOwner(auth))
    scope.register(positionRoutes, { db })
    scope.register(employeeRoutes, { db })
  })

  const notFound = (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).send({ error: 'not_found' })

  if (deps.adminDistDir && existsSync(deps.adminDistDir)) {
    app.register(fastifyStatic, { root: deps.adminDistDir })
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? ''
      const looksLikeFile = /\.[a-z0-9]+$/i.test(path)
      if (req.method === 'GET' && !path.startsWith('/api/') && !looksLikeFile) {
        return reply.sendFile('index.html')
      }
      return notFound(req, reply)
    })
  } else {
    app.setNotFoundHandler(notFound)
  }

  return app
}
