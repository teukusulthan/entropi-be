import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { paymentService } from '../services/payment-service';
import { eventService } from '../services/event-service';
import { orderProjection } from '../services/order-projection';
import { validateIdempotencyKey } from '../middleware/idempotency';
import { AppError, OrderNotFoundError } from '../lib/errors';
import prisma from '../lib/prisma';
import { fromPrismaDecimal } from '../lib/decimal';

const PayOrderSchema = z.object({
  idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
});

export async function paymentRoutes(fastify: FastifyInstance) {
  fastify.post('/api/orders/:id/pay', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = PayOrderSchema.parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) {
        throw new OrderNotFoundError(id);
      }

      const amount = fromPrismaDecimal(order.amount).toString();

      const result = await paymentService.processPayment(
        id,
        amount,
        order.customerId,
        idempotencyKey
      );

      const statusCode = result.idempotent ? 200 : 201;
      return reply.status(statusCode).send({
        order: result.order,
        payment: result.payment,
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

  fastify.post('/api/orders/:id/fees', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = z.object({
        idempotencyKey: z.string().min(1),
      }).parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const order = await prisma.order.findUnique({ where: { id } });
      if (!order) {
        throw new OrderNotFoundError(id);
      }

      const amount = fromPrismaDecimal(order.paymentReceived).toString();

      const result = await eventService.calculateFees(id, amount, idempotencyKey);

      return reply.status(200).send({
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

  fastify.post('/api/orders/:id/refund', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = z.object({
        idempotencyKey: z.string().min(1),
      }).parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const result = await eventService.processRefund(id, idempotencyKey);

      return reply.status(200).send({
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

  fastify.post('/api/orders/:id/ship', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = z.object({
        idempotencyKey: z.string().min(1),
      }).parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const result = await eventService.markOrderShipped(id, idempotencyKey);

      return reply.status(result.idempotent ? 200 : 201).send({
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

  fastify.post('/api/orders/:id/deliver', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = z.object({
        idempotencyKey: z.string().min(1),
      }).parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const result = await eventService.markOrderDelivered(id, idempotencyKey);

      return reply.status(result.idempotent ? 200 : 201).send({
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
}
