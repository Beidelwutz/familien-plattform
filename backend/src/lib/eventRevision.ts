import { prisma } from './prisma.js';

/**
 * Computes a changeset between two event objects
 */
export function computeChangeset(
  original: Record<string, any>,
  updated: Record<string, any>
): Record<string, { old: any; new: any }> {
  const changeset: Record<string, { old: any; new: any }> = {};
  
  // Fields that can be changed
  const editableFields = [
    'title',
    'description_short',
    'description_long',
    'start_datetime',
    'end_datetime',
    'is_all_day',
    'location_address',
    'location_district',
    'location_lat',
    'location_lng',
    'price_type',
    'price_min',
    'price_max',
    'age_min',
    'age_max',
    'is_indoor',
    'is_outdoor',
    'booking_url',
    'contact_email',
    'contact_phone',
    'image_urls',
  ];
  
  for (const field of editableFields) {
    if (updated[field] !== undefined) {
      const oldVal = original[field];
      const newVal = updated[field];
      
      // Compare values (handle dates, decimals, etc.)
      const oldNorm = normalizeValue(oldVal);
      const newNorm = normalizeValue(newVal);
      
      if (JSON.stringify(oldNorm) !== JSON.stringify(newNorm)) {
        changeset[field] = {
          old: oldNorm,
          new: newNorm,
        };
      }
    }
  }
  
  return changeset;
}

function normalizeValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object' && val.toNumber) return val.toNumber(); // Prisma Decimal
  return val;
}

/**
 * Applies a changeset to an event
 */
export function applyChangeset(
  changeset: Record<string, { old: any; new: any }>
): Record<string, any> {
  const updates: Record<string, any> = {};
  
  for (const [field, change] of Object.entries(changeset)) {
    let value = change.new;
    
    // Convert datetime strings back to Date objects
    if (field.includes('datetime') && typeof value === 'string') {
      value = new Date(value);
    }
    
    updates[field] = value;
  }
  
  return updates;
}

/**
 * Creates a revision for a published event
 */
export async function createEventRevision(
  eventId: string,
  changeset: Record<string, { old: any; new: any }>,
  createdBy?: string
): Promise<{ revisionId: string; fieldsChanged: string[] }> {
  const revision = await prisma.eventRevision.create({
    data: {
      event_id: eventId,
      changeset,
      created_by: createdBy || null,
      status: 'pending',
    }
  });
  
  return {
    revisionId: revision.id,
    fieldsChanged: Object.keys(changeset),
  };
}

/**
 * Approves a revision and applies changes to the event
 */
export async function approveRevision(
  revisionId: string,
  reviewedBy: string,
  reviewNote?: string
): Promise<{ eventId: string; fieldsUpdated: string[] }> {
  const revision = await prisma.eventRevision.findUnique({
    where: { id: revisionId },
    include: { event: true }
  });
  
  if (!revision) {
    throw new Error('Revision not found');
  }
  
  if (revision.status !== 'pending') {
    throw new Error(`Revision is already ${revision.status}`);
  }
  
  const changeset = revision.changeset as Record<string, { old: any; new: any }>;
  const updates = applyChangeset(changeset);
  
  // Apply changes and update revision in a transaction
  await prisma.$transaction([
    prisma.canonicalEvent.update({
      where: { id: revision.event_id },
      data: {
        ...updates,
        updated_at: new Date(),
      }
    }),
    prisma.eventRevision.update({
      where: { id: revisionId },
      data: {
        status: 'approved',
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
        review_note: reviewNote || null,
      }
    })
  ]);
  
  return {
    eventId: revision.event_id,
    fieldsUpdated: Object.keys(changeset),
  };
}

/**
 * Rejects a revision
 */
export async function rejectRevision(
  revisionId: string,
  reviewedBy: string,
  reviewNote?: string
): Promise<void> {
  const revision = await prisma.eventRevision.findUnique({
    where: { id: revisionId }
  });
  
  if (!revision) {
    throw new Error('Revision not found');
  }
  
  if (revision.status !== 'pending') {
    throw new Error(`Revision is already ${revision.status}`);
  }
  
  await prisma.eventRevision.update({
    where: { id: revisionId },
    data: {
      status: 'rejected',
      reviewed_by: reviewedBy,
      reviewed_at: new Date(),
      review_note: reviewNote || null,
    }
  });
}

/**
 * Gets pending revisions for an event
 */
export async function getPendingRevisions(eventId: string) {
  return prisma.eventRevision.findMany({
    where: {
      event_id: eventId,
      status: 'pending',
    },
    orderBy: { created_at: 'desc' },
    include: {
      created_by_user: {
        select: { id: true, email: true }
      }
    }
  });
}
