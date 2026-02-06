import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Alle Events mit allen Feldern
const allEvents = await prisma.canonicalEvent.findMany({
  select: {
    id: true,
    title: true,
    start_datetime: true,
    end_datetime: true,
    status: true,
    description_short: true,
    primary_source: {
      select: {
        normalized_data: true,
        raw_data: true
      }
    }
  },
  take: 5
});

allEvents.forEach(e => {
  console.log("===================");
  console.log("Title:", e.title?.substring(0,50));
  console.log("Status:", e.status);
  console.log("start_datetime:", e.start_datetime);
  console.log("end_datetime:", e.end_datetime);
  
  if (e.primary_source?.normalized_data) {
    const norm = e.primary_source.normalized_data;
    console.log("normalized_data.start_datetime:", norm.start_datetime);
  }
  if (e.primary_source?.raw_data) {
    const raw = e.primary_source.raw_data;
    console.log("raw_data keys:", Object.keys(raw || {}));
  }
});

// Schaue auch in EventSource Tabelle
console.log("\n\n=== EVENT SOURCES ===");
const sources = await prisma.eventSource.findMany({
  take: 3,
  select: {
    id: true,
    normalized_data: true,
    canonical_event: {
      select: { title: true, start_datetime: true }
    }
  }
});

sources.forEach(s => {
  console.log("---");
  console.log("Event:", s.canonical_event?.title?.substring(0, 40));
  console.log("Event start_datetime:", s.canonical_event?.start_datetime);
  if (s.normalized_data) {
    console.log("normalized_data.start_datetime:", s.normalized_data.start_datetime);
  }
});

await prisma.$disconnect();
