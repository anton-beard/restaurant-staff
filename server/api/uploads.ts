import type { FastifyPluginAsync } from 'fastify'
import fastifyStatic from '@fastify/static'

export const uploadRoutes: FastifyPluginAsync<{ uploadsDir: string }> = async (app, { uploadsDir }) => {
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/api/uploads/',
    decorateReply: false,
    index: false,
    list: false,
  })
}
