import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'

export type AppDeps = {
  config: Config
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.get('/healthz', async () => ({ ok: true }))

  void deps
  return app
}
