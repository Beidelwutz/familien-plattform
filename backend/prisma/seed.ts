import { PrismaClient, SourceType, HealthStatus, PartnershipStatus } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create categories
  const categories = [
    { slug: 'museum', name_de: 'Museum', icon: '🏛️' },
    { slug: 'sport', name_de: 'Sport', icon: '⚽' },
    { slug: 'natur', name_de: 'Natur', icon: '🌳' },
    { slug: 'musik', name_de: 'Musik', icon: '🎵' },
    { slug: 'theater', name_de: 'Theater', icon: '🎭' },
    { slug: 'workshop', name_de: 'Workshop', icon: '🎨' },
    { slug: 'indoor-spielplatz', name_de: 'Indoor-Spielplatz', icon: '🏠' },
    { slug: 'ferienlager', name_de: 'Ferienlager', icon: '⛺' },
    { slug: 'kino', name_de: 'Kino', icon: '🎬' },
    { slug: 'zoo', name_de: 'Zoo & Tierpark', icon: '🦁' },
    { slug: 'schwimmen', name_de: 'Schwimmen', icon: '🏊' },
    { slug: 'klettern', name_de: 'Klettern', icon: '🧗' },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: cat,
    });
  }
  console.log(`✅ Created ${categories.length} categories`);

  // Create amenities
  const amenities = [
    { slug: 'toilette', name_de: 'Toilette', icon: '🚻' },
    { slug: 'wickeltisch', name_de: 'Wickeltisch', icon: '👶' },
    { slug: 'parkplatz', name_de: 'Parkplatz', icon: '🅿️' },
    { slug: 'oepnv', name_de: 'ÖPNV gut erreichbar', icon: '🚌' },
    { slug: 'snacks', name_de: 'Snacks/Essen', icon: '🍕' },
    { slug: 'kinderwagen', name_de: 'Kinderwagen-freundlich', icon: '👶' },
    { slug: 'barrierefrei', name_de: 'Barrierefrei', icon: '♿' },
    { slug: 'stillen', name_de: 'Stillraum', icon: '🤱' },
  ];

  for (const amenity of amenities) {
    await prisma.amenity.upsert({
      where: { slug: amenity.slug },
      update: {},
      create: amenity,
    });
  }
  console.log(`✅ Created ${amenities.length} amenities`);

  // Create district aliases for Karlsruhe
  const districts = [
    { 
      canonical_name: 'Karlsruhe-Innenstadt', 
      aliases: ['Innenstadt', 'Zentrum', 'City', 'KA-Innenstadt'],
      center_lat: 49.0069,
      center_lng: 8.4037
    },
    { 
      canonical_name: 'Karlsruhe-Durlach', 
      aliases: ['Durlach', 'KA-Durlach'],
      center_lat: 49.0011,
      center_lng: 8.4708
    },
    { 
      canonical_name: 'Karlsruhe-Südweststadt', 
      aliases: ['Südweststadt', 'KA-Südwest', 'Südwest'],
      center_lat: 48.9969,
      center_lng: 8.3916
    },
    { 
      canonical_name: 'Karlsruhe-Mühlburg', 
      aliases: ['Mühlburg', 'KA-Mühlburg'],
      center_lat: 49.0147,
      center_lng: 8.3700
    },
    { 
      canonical_name: 'Karlsruhe-Neureut', 
      aliases: ['Neureut', 'KA-Neureut'],
      center_lat: 49.0411,
      center_lng: 8.3756
    },
  ];

  for (const district of districts) {
    await prisma.districtAlias.upsert({
      where: { canonical_name: district.canonical_name },
      update: { aliases: district.aliases },
      create: {
        canonical_name: district.canonical_name,
        aliases: district.aliases,
        center_lat: district.center_lat,
        center_lng: district.center_lng,
      },
    });
  }
  console.log(`✅ Created ${districts.length} district aliases`);

  // Create initial sources for Karlsruhe
  const sources = [
    {
      name: 'karlsruhe.de Veranstaltungen',
      type: SourceType.rss,
      url: 'https://kalender.karlsruhe.de/db/termine/rss',
      schedule_cron: '0 */6 * * *', // Every 6 hours
      health_status: HealthStatus.unknown,
      priority: 2,
      expected_event_count_min: 20,
      notes: 'Offizieller Veranstaltungskalender der Stadt Karlsruhe (RSS-Feed)',
    },
    {
      name: 'Badisches Landesmuseum',
      type: SourceType.ics,
      url: 'https://www.landesmuseum.de/veranstaltungen',
      schedule_cron: '0 8 * * *', // Daily at 8am
      health_status: HealthStatus.unknown,
      priority: 2,
      expected_event_count_min: 5,
      notes: 'Museum im Schloss',
    },
    {
      name: 'Zoo Karlsruhe',
      type: SourceType.scraper,
      url: 'https://www.karlsruhe.de/zoo',
      schedule_cron: '0 8 * * 1', // Weekly on Monday
      health_status: HealthStatus.unknown,
      priority: 3,
      scrape_allowed: true,
      expected_event_count_min: 2,
      notes: 'Events und Führungen im Zoo',
    },
    {
      name: 'ZKM Karlsruhe',
      type: SourceType.api,
      url: 'https://zkm.de/veranstaltungen',
      schedule_cron: '0 */12 * * *', // Every 12 hours
      health_status: HealthStatus.unknown,
      priority: 2,
      expected_event_count_min: 10,
      notes: 'Zentrum für Kunst und Medien',
    },
    {
      name: 'Naturkundemuseum Karlsruhe',
      type: SourceType.scraper,
      url: 'https://www.smnk.de/veranstaltungen',
      schedule_cron: '0 8 * * *',
      health_status: HealthStatus.unknown,
      priority: 3,
      expected_event_count_min: 3,
      notes: 'Naturkundemuseum',
    },
  ];

  for (const source of sources) {
    const existing = await prisma.source.findFirst({
      where: { name: source.name }
    });

    if (!existing) {
      const created = await prisma.source.create({
        data: source,
      });

      // Create compliance record
      await prisma.sourceCompliance.create({
        data: {
          source_id: created.id,
          partnership_status: PartnershipStatus.none,
        }
      });
    }
  }
  console.log(`✅ Created ${sources.length} sources`);

  // Create admin user
  const adminHash = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: 'admin@kiezling.com' },
    update: { password_hash: adminHash, role: 'admin' },
    create: {
      email: 'admin@kiezling.com',
      password_hash: adminHash,
      role: 'admin',
    },
  });
  console.log('✅ Admin created: admin@kiezling.com / admin123');

  console.log('✨ Seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
