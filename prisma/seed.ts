import { PrismaClient, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create a sample order
  const orderId = uuid();
  const eventId = uuid();

  await prisma.order.create({
    data: {
      id: orderId,
      customerId: 'seed-customer-1',
      amount: new Prisma.Decimal('100.0000'),
      paymentMethod: 'card',
      status: 'PENDING',
      version: 1,
    },
  });

  await prisma.eventLog.create({
    data: {
      id: eventId,
      aggregateId: orderId,
      eventType: 'ORDER_CREATED',
      payload: {
        amount: '100.0000',
        customerId: 'seed-customer-1',
        paymentMethod: 'card',
      },
      version: 1,
      idempotencyKey: `seed-${orderId}`,
    },
  });

  await prisma.ledgerEntry.createMany({
    data: [
      {
        id: uuid(),
        orderId,
        account: 'ORDER_BALANCE',
        debit: new Prisma.Decimal('100.0000'),
        credit: null,
        description: `Seed order ${orderId} - balance`,
        eventId,
      },
      {
        id: uuid(),
        orderId,
        account: 'ORDER_PENDING',
        debit: null,
        credit: new Prisma.Decimal('100.0000'),
        description: `Seed order ${orderId} - pending`,
        eventId,
      },
    ],
  });

  console.log(`Created seed order: ${orderId}`);
  console.log('Seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
