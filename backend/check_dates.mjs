import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Gibt es IRGENDWELCHE Events mit start_datetime?
const withDate = await prisma.canonicalEvent.count({
  where: { start_datetime: { not: null } }
});
const total = await prisma.canonicalEvent.count();

console.log(`Events mit start_datetime: ${withDate}`);
console.log(`Events ohne start_datetime: ${total - withDate}`);
console.log(`Gesamt: ${total}`);

// Events mit Datum
const eventsWithDate = await prisma.canonicalEvent.findMany({
  where: { start_datetime: { not: null } },
  select: { id: true, title: true, start_datetime: true, status: true }
});

console.log("\nEvents MIT start_datetime:");
eventsWithDate.forEach(e => {
  console.log(`[${e.status}] ${e.title?.substring(0,50)} | ${e.start_datetime}`);
});

await prisma.$disconnect();
