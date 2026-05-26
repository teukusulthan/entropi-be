import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { settlementService } from '../services/settlement-service';
import { validateIdempotencyKey } from '../middleware/idempotency';
import { AppError } from '../lib/errors';

const SettleSchema = z.object({
  date: z.string().refine(
    (v) => !isNaN(Date.parse(v)),
    { message: 'date must be a valid ISO date string' }
  ),
  idempotencyKey: z.string().min(1, 'idempotencyKey is required'),
});

export async function settlementRoutes(fastify: FastifyInstance) {
  fastify.post('/api/settle', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = SettleSchema.parse(request.body);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);

      const result = await settlementService.processDailySettlement(body.date, idempotencyKey);

      return reply.status(200).send({
        settlement: result.settlement,
        processedOrders: result.processedOrders,
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

  fastify.get('/api/verify-ledger/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const result = await settlementService.verifyLedger(id);
      return reply.send(result);
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
