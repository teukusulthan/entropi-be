import Fastify, { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health-routes';
import { orderRoutes } from './routes/order-routes';
import { paymentRoutes } from './routes/payment-routes';
import { settlementRoutes } from './routes/settlement-routes';
import { config } from './config';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== 'test' });
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const statusCode = 'statusCode' in error ? (error as FastifyError).statusCode ?? 500 : 500;
    const code = 'code' in error ? (error as FastifyError).code ?? 'INTERNAL_ERROR' : 'INTERNAL_ERROR';
    if (statusCode >= 500) request.log.error(error);
    reply.status(statusCode).send({ error: code, message: error.message });
  });
  await app.register(healthRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(settlementRoutes);
  return app;
}
