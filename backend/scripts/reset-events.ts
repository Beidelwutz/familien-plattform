import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.canonicalEvent.updateMany({
    where: { status: 'rejected' },
    data: { status: 'pending_ai' },
  });
  console.log('Reset rejected → pending_ai:', result.count);
  await prisma.$disconnect();
}

main().catch(console.error);
