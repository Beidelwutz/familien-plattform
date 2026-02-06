import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Schaue mir die incomplete Events an
const incompleteEvents = await prisma.canonicalEvent.findMany({
  where: { status: "incomplete" },
  select: { 
    id: true, 
    title: true, 
    start_datetime: true,
    created_at: true,
    updated_at: true
  },
  take: 40
});

console.log(`INCOMPLETE EVENTS (${incompleteEvents.length}):`);
incompleteEvents.forEach(e => {
  console.log(`Title: ${e.title?.substring(0,60)}`);
  console.log(`  start_datetime: ${e.start_datetime}`);
  console.log(`  created_at: ${e.created_at}`);
  console.log(`  updated_at: ${e.updated_at}`);
  console.log("---");
});

await prisma.$disconnect();
