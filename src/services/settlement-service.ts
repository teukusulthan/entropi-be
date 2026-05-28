import { EventService, eventService as defaultEventService } from './event-service';
import prisma from '../lib/prisma';

export class SettlementService {
  private eventService: EventService;

  constructor(evtService?: EventService) {
    this.eventService = evtService || defaultEventService;
  }

  async processDailySettlement(dateStr: string, idempotencyKey: string) {
    const date = new Date(dateStr);
    return this.eventService.dailySettlement(date, idempotencyKey);
  }

  async verifyLedger(orderId: string) {
    return this.eventService.verifyLedgerBalance(orderId);
  }

  async getSettlements() {
    return prisma.settlement.findMany({
      orderBy: { settlementDate: 'desc' },
    });
  }
}

export const settlementService = new SettlementService();
