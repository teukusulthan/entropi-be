import { FastifyRequest, FastifyReply } from 'fastify';
import { ValidationError } from '../lib/errors';

export function validateIdempotencyKey(key: unknown): string {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    throw new ValidationError('idempotencyKey is required and must be a non-empty string');
  }
  if (key.length > 255) {
    throw new ValidationError('idempotencyKey must be 255 characters or fewer');
  }
  return key.trim();
}
