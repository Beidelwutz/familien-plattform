/**
 * Deletes all canonical events and related data so you can re-crawl from scratch.
 * Run: npx tsx scripts/delete-all-events.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Lösche alle Events und verknüpfte Daten...');

  // 1. DupCandidate (referenziert zwei Events)
  const dupDeleted = await prisma.dupCandidate.deleteMany({});
  console.log(`  DupCandidate: ${dupDeleted.count} gelöscht`);

  // 2. PlanSlot: event_id auf null setzen (Pläne bleiben erhalten)
  const planUpdated = await prisma.planSlot.updateMany({
    where: { event_id: { not: null } },
    data: { event_id: null }
  });
  console.log(`  PlanSlot: ${planUpdated.count} von Event entkoppelt`);

  // 3. SavedEvent (User-Merklisten)
  const savedDeleted = await prisma.savedEvent.deleteMany({});
  console.log(`  SavedEvent: ${savedDeleted.count} gelöscht`);

  // 4. EventSource: Verknüpfung zu Events aufheben (Sources bleiben für Re-Crawl)
  const sourcesUpdated = await prisma.eventSource.updateMany({
    where: { canonical_event_id: { not: null } },
    data: { canonical_event_id: null }
  });
  console.log(`  EventSource: ${sourcesUpdated.count} von Event entkoppelt`);

  // 5. RawEventItem: Verknüpfung aufheben (Rohdaten bleiben für Idempotenz optional)
  const rawUpdated = await prisma.rawEventItem.updateMany({
    where: { canonical_event_id: { not: null } },
    data: { canonical_event_id: null }
  });
  console.log(`  RawEventItem: ${rawUpdated.count} von Event entkoppelt`);

  // 6. CanonicalEvent: primary_source_id und rescheduled_to_event_id aufheben
  await prisma.canonicalEvent.updateMany({
    data: {
      primary_source_id: null,
      rescheduled_to_event_id: null
    }
  });

  // 7. Alle CanonicalEvents löschen (Cascade löscht EventScore, EventCategory, EventAmenity, EventRevision)
  const eventsDeleted = await prisma.canonicalEvent.deleteMany({});
  console.log(`  CanonicalEvent: ${eventsDeleted.count} gelöscht`);

  console.log('\nFertig. Du kannst jetzt neu crawlen.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
