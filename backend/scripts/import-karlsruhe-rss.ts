/**
 * Karlsruhe RSS Feed Importer
 * 
 * Importiert Veranstaltungen direkt vom RSS-Feed der Stadt Karlsruhe
 * ohne den AI-Worker zu benötigen.
 * 
 * Usage: npx tsx scripts/import-karlsruhe-rss.ts
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const RSS_FEED_URL = 'https://kalender.karlsruhe.de/db/termine/rss';

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
}

// Simple RSS parser (without external dependencies)
async function parseRssFeed(url: string): Promise<RssItem[]> {
  console.log(`📡 Fetching RSS feed from ${url}...`);
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch RSS feed: ${response.status} ${response.statusText}`);
  }
  
  const xml = await response.text();
  const items: RssItem[] = [];
  
  // Simple regex-based XML parsing for RSS items
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    
    const title = extractTag(itemXml, 'title');
    const link = extractTag(itemXml, 'link');
    const description = extractTag(itemXml, 'description');
    const pubDate = extractTag(itemXml, 'pubDate');
    const guid = extractTag(itemXml, 'guid') || link;
    
    if (title) {
      items.push({
        title: decodeHtmlEntities(title),
        link: link || '',
        description: decodeHtmlEntities(stripHtml(description || '')),
        pubDate: pubDate || '',
        guid: guid || crypto.randomUUID(),
      });
    }
  }
  
  console.log(`✅ Parsed ${items.length} items from RSS feed`);
  return items;
}

function extractTag(xml: string, tagName: string): string {
  // Handle CDATA sections
  const cdataRegex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }
  
  // Handle regular content
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß');
}

function computeFingerprint(title: string, dateStr: string): string {
  const normalizedTitle = title.toLowerCase().trim();
  const dateOnly = dateStr ? new Date(dateStr).toISOString().split('T')[0] : '';
  const key = `${normalizedTitle}|${dateOnly}|`;
  return crypto.createHash('sha256').update(key).digest('hex').substring(0, 32);
}

function parseEventDate(pubDate: string): Date | null {
  if (!pubDate) return null;
  
  try {
    const date = new Date(pubDate);
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

async function importEvents() {
  console.log('🚀 Starting Karlsruhe RSS Import...\n');
  
  // Find the Karlsruhe source
  const source = await prisma.source.findFirst({
    where: {
      name: { contains: 'karlsruhe' },
      type: 'rss',
    }
  });
  
  if (!source) {
    throw new Error('Karlsruhe RSS source not found in database. Run db:seed first.');
  }
  
  console.log(`📌 Found source: ${source.name} (${source.id})`);
  console.log(`   URL: ${source.url}\n`);
  
  // Create ingest run
  const ingestRun = await prisma.ingestRun.create({
    data: {
      correlation_id: `import-script-${Date.now()}`,
      source_id: source.id,
      status: 'running',
    }
  });
  
  try {
    // Fetch and parse RSS
    const items = await parseRssFeed(RSS_FEED_URL);
    
    let created = 0;
    let updated = 0;
    let skipped = 0;
    
    for (const item of items) {
      const startDate = parseEventDate(item.pubDate);
      const fingerprint = computeFingerprint(item.title, item.pubDate);
      const externalId = item.guid.substring(0, 255);
      
      // Check if event source already exists
      const existingEventSource = await prisma.eventSource.findFirst({
        where: {
          source_id: source.id,
          external_id: externalId,
        },
        include: {
          canonical_event: true,
        }
      });
      
      if (existingEventSource) {
        // Update existing event source
        await prisma.eventSource.update({
          where: { id: existingEventSource.id },
          data: {
            raw_data: item as any,
            fingerprint,
            updated_at: new Date(),
          }
        });
        
        // Update canonical event if exists
        if (existingEventSource.canonical_event) {
          await prisma.canonicalEvent.update({
            where: { id: existingEventSource.canonical_event.id },
            data: {
              title: item.title.substring(0, 200),
              description_short: item.description.substring(0, 500) || null,
              booking_url: item.link || null,
              updated_at: new Date(),
            }
          });
        }
        
        updated++;
      } else {
        // Create new canonical event
        const canonicalEvent = await prisma.canonicalEvent.create({
          data: {
            title: item.title.substring(0, 200),
            description_short: item.description.substring(0, 500) || null,
            description_long: item.description || null,
            start_datetime: startDate,
            booking_url: item.link || null,
            status: 'pending_review',
            is_complete: false,
            completeness_score: 30, // Low score - needs enrichment
            location_address: 'Karlsruhe', // Default
          }
        });
        
        // Create event source linking to canonical event
        await prisma.eventSource.create({
          data: {
            source_id: source.id,
            canonical_event_id: canonicalEvent.id,
            external_id: externalId,
            source_url: item.link,
            raw_data: item as any,
            fingerprint,
          }
        });
        
        created++;
      }
    }
    
    skipped = items.length - created - updated;
    
    // Update ingest run
    await prisma.ingestRun.update({
      where: { id: ingestRun.id },
      data: {
        status: 'success',
        finished_at: new Date(),
        events_found: items.length,
        events_created: created,
        events_updated: updated,
        events_unchanged: skipped,
      }
    });
    
    // Update source health
    await prisma.source.update({
      where: { id: source.id },
      data: {
        last_success_at: new Date(),
        last_fetch_at: new Date(),
        health_status: 'healthy',
        consecutive_failures: 0,
        avg_events_per_fetch: items.length,
      }
    });
    
    console.log('\n📊 Import Summary:');
    console.log(`   Total items:  ${items.length}`);
    console.log(`   Created:      ${created}`);
    console.log(`   Updated:      ${updated}`);
    console.log(`   Skipped:      ${skipped}`);
    console.log('\n✨ Import completed successfully!');
    
  } catch (error) {
    // Update ingest run with error
    await prisma.ingestRun.update({
      where: { id: ingestRun.id },
      data: {
        status: 'failed',
        finished_at: new Date(),
        error_message: error instanceof Error ? error.message : 'Unknown error',
        needs_attention: true,
      }
    });
    
    // Update source health
    await prisma.source.update({
      where: { id: source.id },
      data: {
        last_failure_at: new Date(),
        last_fetch_at: new Date(),
        health_status: 'failing',
        consecutive_failures: { increment: 1 },
      }
    });
    
    throw error;
  }
}

// Run import
importEvents()
  .catch((error) => {
    console.error('\n❌ Import failed:', error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
