import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const migrate = args.includes('--migrate');
  
  console.log("=== EVENT STATUS DIAGNOSE ===\n");
  
  // 1. Status-Verteilung (using Prisma groupBy)
  console.log("1. EVENT STATUS VERTEILUNG:");
  console.log("-".repeat(40));
  
  const statusCounts = await prisma.canonicalEvent.groupBy({
    by: ['status'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } }
  });
  
  statusCounts.forEach(s => {
    console.log(`  ${(s.status || 'null').padEnd(20)} : ${s._count.id}`);
  });
  
  // 2. Completeness Score bei pending_ai und incomplete
  console.log("\n2. COMPLETENESS SCORE VERTEILUNG (pending_ai vs incomplete):");
  console.log("-".repeat(40));
  
  for (const status of ['pending_ai', 'incomplete', 'pending_review']) {
    const stats = await prisma.canonicalEvent.aggregate({
      where: { status },
      _min: { completeness_score: true },
      _max: { completeness_score: true },
      _avg: { completeness_score: true },
      _count: { id: true }
    });
    
    console.log(`  ${status.padEnd(15)} | Count: ${String(stats._count.id).padStart(4)} | Score: min=${stats._min.completeness_score || 'N/A'}, max=${stats._max.completeness_score || 'N/A'}, avg=${stats._avg.completeness_score?.toFixed(1) || 'N/A'}`);
  }
  
  // Optional: Migrate incomplete to pending_ai
  if (migrate) {
    console.log("\n=== MIGRATION: incomplete -> pending_ai ===");
    const result = await prisma.canonicalEvent.updateMany({
      where: { status: 'incomplete' },
      data: { status: 'pending_ai' }
    });
    console.log(`  Migriert: ${result.count} Events von 'incomplete' zu 'pending_ai'`);
  } else {
    console.log("\n(Tipp: Fuehre 'node temp_query.js --migrate' aus, um incomplete Events zu pending_ai zu migrieren)");
  }
  
  // 3. Letzte 10 importierte Events
  console.log("\n3. LETZTE 10 IMPORTIERTE EVENTS:");
  console.log("-".repeat(40));
  
  const recentEvents = await prisma.canonicalEvent.findMany({
    orderBy: { created_at: 'desc' },
    take: 10,
    select: {
      id: true,
      title: true,
      status: true,
      completeness_score: true,
      created_at: true,
    }
  });
  
  recentEvents.forEach(e => {
    const date = e.created_at ? new Date(e.created_at).toISOString().substring(0, 16) : 'NULL';
    console.log(`  [${e.status.padEnd(15)}] Score: ${String(e.completeness_score || 0).padStart(3)} | ${date} | ${e.title?.substring(0, 40) || 'Kein Titel'}`);
  });
  
  // 4. Events mit pending_ai Status (zur Bestätigung dass sie existieren)
  console.log("\n4. EVENTS MIT STATUS 'pending_ai' (max 5):");
  console.log("-".repeat(40));
  
  const pendingAiEvents = await prisma.canonicalEvent.findMany({
    where: { status: 'pending_ai' },
    take: 5,
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      title: true,
      completeness_score: true,
      created_at: true,
    }
  });
  
  if (pendingAiEvents.length === 0) {
    console.log("  KEINE Events mit status 'pending_ai' gefunden!");
  } else {
    pendingAiEvents.forEach(e => {
      console.log(`  ID: ${e.id.substring(0, 8)}... | Score: ${e.completeness_score} | ${e.title?.substring(0, 40)}`);
    });
  }
  
  // 5. IngestRun Status (letzte 5)
  console.log("\n5. LETZTE 5 INGEST RUNS:");
  console.log("-".repeat(40));
  
  const ingestRuns = await prisma.ingestRun.findMany({
    orderBy: { started_at: 'desc' },
    take: 5,
    select: {
      id: true,
      status: true,
      events_created: true,
      events_updated: true,
      started_at: true,
      source: { select: { name: true } }
    }
  });
  
  ingestRuns.forEach(r => {
    const date = r.started_at ? new Date(r.started_at).toISOString().substring(0, 16) : 'NULL';
    console.log(`  [${r.status.padEnd(10)}] ${date} | Created: ${r.events_created || 0}, Updated: ${r.events_updated || 0} | ${r.source?.name || 'Unknown'}`);
  });
  
  console.log("\n=== DIAGNOSE ENDE ===");
  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  prisma.$disconnect();
});
