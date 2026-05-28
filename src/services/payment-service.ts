import { v4 as uuid } from 'uuid';
import { CardDeclinedError } from '../lib/errors';
import { EventService, eventService as defaultEventService } from './event-service';

export interface StripeCharge {
  chargeId: string;
  status: 'succeeded' | 'failed';
  amount: string;
}

export class StripeMock {
  private shouldFail: boolean = false;
  private chargesByKey = new Map<string, StripeCharge>();

  setFailMode(fail: boolean): void {
    this.shouldFail = fail;
  }

  async charge(amount: string, customerId: string, idempotencyKey?: string): Promise<StripeCharge> {
    if (idempotencyKey) {
      const existing = this.chargesByKey.get(idempotencyKey);
      if (existing) return existing;
    }

    await new Promise((r) => setTimeout(r, Math.random() * 50));

    if (this.shouldFail) {
      throw new CardDeclinedError('Card declined');
    }

    const charge: StripeCharge = {
      chargeId: `ch_${uuid()}`,
      status: 'succeeded',
      amount,
    };

    if (idempotencyKey) {
      this.chargesByKey.set(idempotencyKey, charge);
    }

    return charge;
  }
}

export const stripeMock = new StripeMock();

export class PaymentService {
  private stripe: StripeMock;
  private eventService: EventService;

  constructor(stripe?: StripeMock, evtService?: EventService) {
    this.stripe = stripe || stripeMock;
    this.eventService = evtService || defaultEventService;
  }

  async processPayment(
    orderId: string,
    amount: string,
    customerId: string,
    idempotencyKey: string
  ) {
    const processingResult = await this.eventService.startPaymentProcessing(
      orderId,
      `${idempotencyKey}-processing`
    );

    if (processingResult.idempotent) {
      // Order is already past PAYMENT_PROCESSING — full payment flow completed
      if (processingResult.order?.status !== 'PAYMENT_PROCESSING') {
        return {
          order: processingResult.order,
          payment: null,
          event: processingResult.event,
          idempotent: true,
        };
      }
      // Order is still PAYMENT_PROCESSING: processing event was recorded but
      // the charge + confirmation never completed. Fall through to retry the charge.
    }

    try {
      const charge = await this.stripe.charge(amount, customerId, `${idempotencyKey}-stripe`);

      const paymentResult = await this.eventService.recordPayment(
        orderId,
        amount,
        charge.chargeId,
        `${idempotencyKey}-confirmed`
      );

      return {
        order: paymentResult.order,
        payment: charge,
        event: paymentResult.event,
        idempotent: false,
      };
    } catch (error) {
      if (error instanceof CardDeclinedError) {
        await this.eventService.revertToPaymentPending(
          orderId,
          `${idempotencyKey}-reverted`
        );
        throw error;
      }
      throw error;
    }
  }
}

export const paymentService = new PaymentService();
