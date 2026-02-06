import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Nehme ein Beispiel-Event
const event = await prisma.canonicalEvent.findFirst({
  where: { title: { contains: "Regenbogenfisch" } },
  include: {
    primary_source: {
      include: { source: true }
    },
    event_sources: true,
    raw_event_items: true
  }
});

console.log("EVENT:", event?.title);
console.log("start_datetime:", event?.start_datetime);
console.log("\nPRIMARY SOURCE:");
console.log(JSON.stringify(event?.primary_source, null, 2));

console.log("\nRAW EVENT ITEMS:");
if (event?.raw_event_items?.length) {
  event.raw_event_items.forEach(item => {
    console.log("extracted_fields:", JSON.stringify(item.extracted_fields, null, 2));
  });
} else {
  console.log("Keine raw_event_items gefunden");
}

await prisma.$disconnect();
