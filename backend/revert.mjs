import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Setze alle Events die ich gerade auf incomplete gesetzt habe zurueck auf published
// (updated_at am 2026-02-04 20:07:29)
const result = await prisma.canonicalEvent.updateMany({
  where: {
    status: "incomplete",
    updated_at: {
      gte: new Date("2026-02-04T19:07:00.000Z"),
      lte: new Date("2026-02-04T19:08:00.000Z")
    }
  },
  data: { status: "published" }
});

console.log(`${result.count} Events zurueck auf 'published' gesetzt.`);

// Verify
const published = await prisma.canonicalEvent.count({
  where: { status: "published" }
});
console.log(`Gesamt published Events: ${published}`);

await prisma.$disconnect();
