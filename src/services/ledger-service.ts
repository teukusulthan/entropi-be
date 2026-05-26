import { PrismaClient, AccountType } from '@prisma/client';
import { Decimal, fromPrismaDecimal, toFixed4 } from '../lib/decimal';
import prisma from '../lib/prisma';

export class LedgerService {
  private db: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.db = prismaClient || prisma;
  }

  async getOrderLedger(orderId: string) {
    const entries = await this.db.ledgerEntry.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);

    for (const entry of entries) {
      if (entry.debit) {
        totalDebits = totalDebits.plus(fromPrismaDecimal(entry.debit));
      }
      if (entry.credit) {
        totalCredits = totalCredits.plus(fromPrismaDecimal(entry.credit));
      }
    }

    return {
      entries,
      balance: {
        totalDebits: toFixed4(totalDebits),
        totalCredits: toFixed4(totalCredits),
        balanced: totalDebits.equals(totalCredits),
      },
    };
  }

  async getAccountSummary(orderId: string) {
    const entries = await this.db.ledgerEntry.findMany({
      where: { orderId },
      orderBy: { timestamp: 'asc' },
    });

    const accounts: Record<string, { debits: Decimal; credits: Decimal }> = {};

    for (const entry of entries) {
      if (!accounts[entry.account]) {
        accounts[entry.account] = { debits: new Decimal(0), credits: new Decimal(0) };
      }
      if (entry.debit) {
        accounts[entry.account].debits = accounts[entry.account].debits.plus(
          fromPrismaDecimal(entry.debit)
        );
      }
      if (entry.credit) {
        accounts[entry.account].credits = accounts[entry.account].credits.plus(
          fromPrismaDecimal(entry.credit)
        );
      }
    }

    const summary: Record<string, { debits: string; credits: string; net: string }> = {};
    for (const [account, balances] of Object.entries(accounts)) {
      summary[account] = {
        debits: toFixed4(balances.debits),
        credits: toFixed4(balances.credits),
        net: toFixed4(balances.debits.minus(balances.credits)),
      };
    }

    return summary;
  }
}

export const ledgerService = new LedgerService();
