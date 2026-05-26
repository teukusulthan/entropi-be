import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { eventService } from '../services/event-service';
import { ledgerService } from '../services/ledger-service';
import { orderProjection } from '../services/order-projection';
import { validateIdempotencyKey } from '../middleware/idempotency';
import { AppError } from '../lib/errors';

const CreateOrderSchema = z.object({
  amount: z.string().refine((v) => !isNaN(Number(v)) && Number(v) > 0, {
    message: 'amount must be a positive numeric string',
  }),
  customerId: z.string().min(1, 'customerId is required'),
  paymentMethod: z.string().min(1, 'paymentMethod is required'),
  idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
});

export async function orderRoutes(fastify: FastifyInstance) {
  fastify.get('/api/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orders = await orderProjection.listOrders();
      return reply.send(orders);
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  fastify.post('/api/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreateOrderSchema.parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);
      const orderId = uuid();

      const result = await eventService.recordOrder(
        orderId,
        body.amount,
        body.customerId,
        body.paymentMethod,
        idempotencyKey
      );

      const statusCode = result.idempotent ? 200 : 201;
      return reply.status(statusCode).send({
        order: result.order,
        event: result.event,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'VALIDATION_ERROR',
          message: error.errors.map((e) => e.message).join(', '),
        });
      }
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  fastify.get('/api/orders/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const order = await orderProjection.getOrder(id);
      return reply.send(order);
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  fastify.get('/api/orders/:id/ledger', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const ledger = await ledgerService.getOrderLedger(id);
      return reply.send(ledger);
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });
}
