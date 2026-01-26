import { PrismaClient, SourceType, HealthStatus, PartnershipStatus } from '@prisma/client';

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
      url: 'https://www.karlsruhe.de/veranstaltungen',
      schedule_cron: '0 */6 * * *', // Every 6 hours
      health_status: HealthStatus.unknown,
      priority: 2,
      expected_event_count_min: 20,
      notes: 'Offizielle Stadt-Website',
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

  // Create sample events for testing
  const sampleEvents = [
    {
      title: 'Familienführung im Zoo Karlsruhe',
      description_short: 'Entdeckt gemeinsam die Tierwelt! Altersgerechte Führung für Familien.',
      description_long: 'Bei unserer Familienführung durch den Zoo Karlsruhe lernt ihr spannende Tiere kennen. Unsere erfahrenen Guides erklären kindgerecht, was Elefanten am liebsten fressen und warum Pinguine nicht frieren.',
      start_datetime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // In 1 week
      end_datetime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), // 2 hours
      location_address: 'Ettlinger Str. 6, 76137 Karlsruhe',
      location_district: 'Karlsruhe-Südweststadt',
      location_lat: 49.0045,
      location_lng: 8.4020,
      price_type: 'paid',
      price_min: 8.00,
      age_min: 4,
      age_max: 12,
      is_indoor: false,
      is_outdoor: true,
      booking_url: 'https://www.karlsruhe.de/zoo/fuehrungen',
      status: 'published',
      is_complete: true,
      completeness_score: 95,
    },
    {
      title: 'Kreativ-Workshop: Malen wie die Großen',
      description_short: 'Kinder malen mit echten Künstlermaterialien ihre eigenen Meisterwerke.',
      start_datetime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      location_address: 'Kaiserstraße 47, 76133 Karlsruhe',
      location_district: 'Karlsruhe-Innenstadt',
      location_lat: 49.0096,
      location_lng: 8.3969,
      price_type: 'paid',
      price_min: 15.00,
      age_min: 6,
      age_max: 14,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 85,
    },
    {
      title: 'Spielplatz-Fest Günther-Klotz-Anlage',
      description_short: 'Kostenloses Spielplatzfest mit Hüpfburg, Kinderschminken und Musik.',
      start_datetime: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      location_address: 'Günther-Klotz-Anlage, 76135 Karlsruhe',
      location_lat: 48.9968,
      location_lng: 8.3744,
      price_type: 'free',
      age_min: 0,
      age_max: 14,
      is_indoor: false,
      is_outdoor: true,
      status: 'published',
      is_complete: true,
      completeness_score: 80,
    },
  ];

  for (const event of sampleEvents) {
    const existing = await prisma.canonicalEvent.findFirst({
      where: { title: event.title }
    });

    if (!existing) {
      const created = await prisma.canonicalEvent.create({
        data: event as any,
      });

      // Add scores
      await prisma.eventScore.create({
        data: {
          event_id: created.id,
          relevance_score: 85,
          quality_score: 80,
          family_fit_score: 90,
          stressfree_score: 75,
          confidence: 0.85,
          ai_model_version: 'seed-v1',
        }
      });

      // Add some categories
      const zooCategory = await prisma.category.findUnique({ where: { slug: 'zoo' } });
      if (event.title.includes('Zoo') && zooCategory) {
        await prisma.eventCategory.create({
          data: { event_id: created.id, category_id: zooCategory.id }
        });
      }

      const workshopCategory = await prisma.category.findUnique({ where: { slug: 'workshop' } });
      if (event.title.includes('Workshop') && workshopCategory) {
        await prisma.eventCategory.create({
          data: { event_id: created.id, category_id: workshopCategory.id }
        });
      }
    }
  }
  console.log(`✅ Created ${sampleEvents.length} sample events`);

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
