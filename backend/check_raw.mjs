import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Check RawEventItem for dates
const rawItems = await prisma.rawEventItem.findMany({
  take: 5,
  select: {
    id: true,
    extracted_fields: true,
    source_url: true
  }
});

console.log("RAW EVENT ITEMS (extracted_fields):\n");
rawItems.forEach((item, i) => {
  console.log(`--- Item ${i+1} ---`);
  const fields = item.extracted_fields || {};
  console.log("Title:", fields.title?.substring(0, 40));
  console.log("start_datetime:", fields.start_datetime);
  console.log("dtstart:", fields.dtstart);
  console.log("date:", fields.date);
  console.log("Keys:", Object.keys(fields).join(", "));
  console.log("");
});

await prisma.$disconnect();
