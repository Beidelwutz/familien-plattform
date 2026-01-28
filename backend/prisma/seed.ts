import { PrismaClient, SourceType, HealthStatus, PartnershipStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
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

  // Create sample events for testing (Startseite, Suche, Event-Detail)
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const sampleEvents = [
    {
      title: 'Familienführung im Zoo Karlsruhe',
      description_short: 'Entdeckt gemeinsam die Tierwelt! Altersgerechte Führung für Familien.',
      description_long: 'Bei unserer Familienführung durch den Zoo Karlsruhe lernt ihr spannende Tiere kennen. Unsere erfahrenen Guides erklären kindgerecht, was Elefanten am liebsten fressen und warum Pinguine nicht frieren.',
      start_datetime: new Date(now + 7 * day),
      end_datetime: new Date(now + 7 * day + 2 * 60 * 60 * 1000),
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
      categorySlugs: ['zoo'],
      scores: { relevance: 85, quality: 80, family_fit: 90, stressfree: 88 },
    },
    {
      title: 'Kreativ-Workshop: Malen wie die Großen',
      description_short: 'Kinder malen mit echten Künstlermaterialien ihre eigenen Meisterwerke.',
      description_long: 'In diesem Workshop können Kinder unter Anleitung mit Acrylfarben, Pinseln und Leinwänden experimentieren. Alle Materialien sind inklusive.',
      start_datetime: new Date(now + 3 * day),
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
      categorySlugs: ['workshop'],
      scores: { relevance: 90, quality: 85, family_fit: 85, stressfree: 82 },
    },
    {
      title: 'Spielplatz-Fest Günther-Klotz-Anlage',
      description_short: 'Kostenloses Spielplatzfest mit Hüpfburg, Kinderschminken und Musik.',
      start_datetime: new Date(now + 14 * day),
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
      categorySlugs: ['natur'],
      scores: { relevance: 95, quality: 75, family_fit: 95, stressfree: 90 },
    },
    {
      title: 'Kinderturnen im TSV Durlach',
      description_short: 'Spielerisches Turnen für Kinder von 3 bis 6 Jahren.',
      start_datetime: new Date(now + 1 * day + 10 * 60 * 60 * 1000), // tomorrow 10:00
      location_address: 'Pfinztalstraße 2, 76227 Karlsruhe-Durlach',
      location_district: 'Karlsruhe-Durlach',
      location_lat: 49.0011,
      location_lng: 8.4708,
      price_type: 'paid',
      price_min: 5.00,
      age_min: 3,
      age_max: 6,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 88,
      categorySlugs: ['sport'],
      scores: { relevance: 88, quality: 82, family_fit: 92, stressfree: 85 },
    },
    {
      title: 'Vorlesestunde in der Stadtbibliothek',
      description_short: 'Kostenlose Bilderbuch-Geschichten für Kinder ab 4 Jahren.',
      start_datetime: new Date(now + 2 * day + 15 * 60 * 60 * 1000), // in 2 days 15:00
      location_address: 'Stadtbibliothek Karlsruhe, Lameyplatz 4',
      location_district: 'Karlsruhe-Innenstadt',
      location_lat: 49.0076,
      location_lng: 8.4031,
      price_type: 'free',
      age_min: 4,
      age_max: 8,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 90,
      categorySlugs: ['theater'],
      scores: { relevance: 85, quality: 95, family_fit: 88, stressfree: 92 },
    },
    {
      title: 'Naturkundemuseum: Dino-Tag',
      description_short: 'Rund um Dinosaurier – Mitmach-Stationen und Führungen.',
      start_datetime: new Date(now + 5 * day),
      location_address: 'Naturkundemuseum Karlsruhe, Erbprinzenstraße 13',
      location_district: 'Karlsruhe-Innenstadt',
      location_lat: 49.0089,
      location_lng: 8.4077,
      price_type: 'paid',
      price_min: 8.00,
      age_min: 4,
      age_max: 12,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 92,
      categorySlugs: ['museum'],
      scores: { relevance: 90, quality: 90, family_fit: 90, stressfree: 85 },
    },
    {
      title: 'Waldspaziergang mit dem Förster',
      description_short: 'Familien-Waldwanderung mit kurzen Erklärungen zur Natur.',
      start_datetime: new Date(now + 10 * day + 14 * 60 * 60 * 1000), // in 10 days 14:00
      location_address: 'Treffpunkt Hardtwald, Parkplatz Nord',
      location_lat: 49.0380,
      location_lng: 8.3850,
      price_type: 'free',
      age_min: 0,
      age_max: 99,
      is_indoor: false,
      is_outdoor: true,
      status: 'published',
      is_complete: true,
      completeness_score: 78,
      categorySlugs: ['natur'],
      scores: { relevance: 82, quality: 78, family_fit: 88, stressfree: 88 },
    },
    {
      title: 'Schwimmkurs für Anfänger (5–8 J.)',
      description_short: 'Seepferdchen-Kurs in kleinen Gruppen.',
      start_datetime: new Date(now + 4 * day),
      location_address: 'Hallenbad Süd, Karlsruhe',
      location_lat: 48.9920,
      location_lng: 8.4100,
      price_type: 'paid',
      price_min: 45.00,
      age_min: 5,
      age_max: 8,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 85,
      categorySlugs: ['schwimmen'],
      scores: { relevance: 80, quality: 85, family_fit: 82, stressfree: 75 },
    },
    {
      title: 'Indoor-Spielplatz Bambini – Offene Spielzeit',
      description_short: 'Bällebad, Kletterwand und Tobefläche bei jedem Wetter.',
      start_datetime: new Date(now + 1 * day),
      location_address: 'Industriestr. 40, 76149 Karlsruhe',
      location_lat: 49.0120,
      location_lng: 8.3550,
      price_type: 'paid',
      price_min: 9.50,
      age_min: 1,
      age_max: 10,
      is_indoor: true,
      is_outdoor: false,
      status: 'published',
      is_complete: true,
      completeness_score: 88,
      categorySlugs: ['indoor-spielplatz'],
      scores: { relevance: 92, quality: 85, family_fit: 92, stressfree: 90 },
    },
    {
      title: 'Familien-Yoga im Schlosspark',
      description_short: 'Entspanntes Yoga für Eltern und Kinder im Grünen.',
      start_datetime: new Date(now + 6 * day + 10 * 60 * 60 * 1000),
      location_address: 'Schlossgarten Karlsruhe',
      location_lat: 49.0142,
      location_lng: 8.4044,
      price_type: 'paid',
      price_min: 12.00,
      age_min: 3,
      age_max: 12,
      is_indoor: false,
      is_outdoor: true,
      status: 'published',
      is_complete: true,
      completeness_score: 82,
      categorySlugs: ['sport', 'natur'],
      scores: { relevance: 85, quality: 80, family_fit: 92, stressfree: 92 },
    },
  ];

  const slugToId = new Map<string, string>();
  for (const c of categories) {
    const cat = await prisma.category.findUnique({ where: { slug: c.slug } });
    if (cat) slugToId.set(c.slug, cat.id);
  }

  for (const ev of sampleEvents) {
    const { categorySlugs, scores, ...rest } = ev as typeof sampleEvents[0] & {
      categorySlugs: string[];
      scores: { relevance: number; quality: number; family_fit: number; stressfree: number };
    };
    const existing = await prisma.canonicalEvent.findFirst({
      where: { title: rest.title }
    });

    if (!existing) {
      const createData: Prisma.CanonicalEventUncheckedCreateInput = {
        title: rest.title,
        description_short: rest.description_short ?? undefined,
        description_long: rest.description_long ?? undefined,
        start_datetime: rest.start_datetime,
        end_datetime: rest.end_datetime ?? undefined,
        location_address: rest.location_address ?? undefined,
        location_district: rest.location_district ?? undefined,
        location_lat: rest.location_lat ?? undefined,
        location_lng: rest.location_lng ?? undefined,
        price_type: rest.price_type,
        price_min: rest.price_min ?? undefined,
        price_max: rest.price_max ?? undefined,
        age_min: rest.age_min ?? undefined,
        age_max: rest.age_max ?? undefined,
        is_indoor: rest.is_indoor,
        is_outdoor: rest.is_outdoor,
        booking_url: rest.booking_url ?? undefined,
        status: rest.status,
        is_complete: rest.is_complete,
        completeness_score: rest.completeness_score ?? undefined,
      };
      const created = await prisma.canonicalEvent.create({
        data: createData,
      });

      await prisma.eventScore.create({
        data: {
          event_id: created.id,
          relevance_score: scores.relevance,
          quality_score: scores.quality,
          family_fit_score: scores.family_fit,
          stressfree_score: scores.stressfree,
          confidence: 0.9,
          ai_model_version: 'seed-v1',
        }
      });

      for (const slug of categorySlugs) {
        const cid = slugToId.get(slug);
        if (cid) {
          await prisma.eventCategory.create({
            data: { event_id: created.id, category_id: cid }
          });
        }
      }
    }
  }
  console.log(`✅ Created ${sampleEvents.length} sample events`);

  // Create admin user
  const adminHash = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: 'admin@familien-lokal.de' },
    update: { password_hash: adminHash, role: 'admin' },
    create: {
      email: 'admin@familien-lokal.de',
      password_hash: adminHash,
      role: 'admin',
    },
  });
  console.log('✅ Admin created: admin@familien-lokal.de / admin123');

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
