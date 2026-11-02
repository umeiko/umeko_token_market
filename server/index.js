import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { adminRoutes } from './admin.js';
import { db, ensureAdmin, getSettings } from './db.js';
import { Gateway, sendGatewayError } from './gateway.js';
import { Tunnel } from './tunnel.js';

const basePath = `/${(process.env.BASE_PATH || '').replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 20 * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 24 * 1024 * 1024 } });
ensureAdmin();
const tunnel = new Tunnel(app.log);
const gateway = new Gateway(tunnel, getSettings);

await app.register(async (relay) => {
  relay.get('/health', async () => ({ status: 'ok', providers_online: tunnel.providers.size }));
  relay.get('/agent/connect', { websocket: true }, (socket) => tunnel.connect(socket));
  relay.get('/v1/models', async (request, reply) => {
    try {
      gateway.authenticate(request.headers.authorization);
      return { object: 'list', data: gateway.models() };
    } catch (error) { return sendGatewayError(reply, error); }
  });
  relay.route({
    method: ['POST'],
    url: '/v1/*',
    handler: async (request, reply) => {
      try { return await gateway.proxy(request, reply); }
      catch (error) { return sendGatewayError(reply, error); }
    },
  });
  await relay.register(adminRoutes, { tunnel, gateway });
}, { prefix: basePath });

const dist = resolve('dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, index: ['index.html'], prefix: `${basePath}/` });
  app.setNotFoundHandler((request, reply) => {
    const isConsolePage = basePath ? request.url === basePath || request.url.startsWith(`${basePath}/`) : true;
    const isApi = request.url.startsWith(`${basePath}/api/`) || request.url.startsWith(`${basePath}/v1/`);
    if (request.method === 'GET' && isConsolePage && !isApi) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
} else {
  app.get(basePath || '/', async () => ({ name: 'Umeko Token Relay', message: 'Run npm run build to enable the admin console.' }));
}

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'Request failed');
  if (reply.sent) return;
  const status = error.statusCode || 500;
  reply.code(status).send({ error: status === 500 ? '服务内部错误' : error.message });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const shutdown = async () => {
  tunnel.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await app.listen({ port, host });
