/**
 * Event Revision System Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    eventRevision: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    canonicalEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/lib/prisma.js';
import {
  computeChangeset,
  createEventRevision,
  applyRevision,
  hasConflicts,
} from '../../src/lib/eventRevision.js';

describe('Event Revision System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('computeChangeset', () => {
    it('should detect changed fields', () => {
      const original = {
        title: 'Original Title',
        description_short: 'Original description',
        price_min: 10,
      };

      const updates = {
        title: 'New Title',
        price_min: 15,
      };

      const changeset = computeChangeset(original, updates);

      expect(changeset).toEqual({
        title: { old: 'Original Title', new: 'New Title' },
        price_min: { old: 10, new: 15 },
      });
    });

    it('should ignore unchanged fields', () => {
      const original = {
        title: 'Same Title',
        price_min: 10,
      };

      const updates = {
        title: 'Same Title',
        price_min: 10,
      };

      const changeset = computeChangeset(original, updates);

      expect(changeset).toEqual({});
    });

    it('should handle null values', () => {
      const original = {
        title: 'Title',
        description_short: null,
      };

      const updates = {
        description_short: 'New description',
      };

      const changeset = computeChangeset(original, updates);

      expect(changeset).toEqual({
        description_short: { old: null, new: 'New description' },
      });
    });

    it('should handle undefined updates', () => {
      const original = {
        title: 'Title',
        price_min: 10,
      };

      const updates = {
        title: undefined,
      };

      const changeset = computeChangeset(original, updates);

      expect(changeset).toEqual({});
    });
  });

  describe('createEventRevision', () => {
    it('should create a revision record', async () => {
      const mockRevision = {
        id: 'rev-1',
        event_id: 'event-1',
        changeset: { title: { old: 'Old', new: 'New' } },
        status: 'pending',
        created_at: new Date(),
      };

      (prisma.eventRevision.create as any).mockResolvedValue(mockRevision);

      const result = await createEventRevision(
        'event-1',
        { title: { old: 'Old', new: 'New' } },
        'user-1'
      );

      expect(prisma.eventRevision.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          event_id: 'event-1',
          changeset: { title: { old: 'Old', new: 'New' } },
          created_by: 'user-1',
          status: 'pending',
        }),
      });

      expect(result.revisionId).toBe('rev-1');
    });

    it('should track fields changed', async () => {
      const changeset = {
        title: { old: 'Old', new: 'New' },
        price_min: { old: 10, new: 20 },
      };

      (prisma.eventRevision.create as any).mockResolvedValue({
        id: 'rev-1',
        changeset,
      });

      const result = await createEventRevision('event-1', changeset, null);

      expect(result.fieldsChanged).toEqual(['title', 'price_min']);
    });
  });

  describe('applyRevision', () => {
    it('should apply approved revision to event', async () => {
      const mockRevision = {
        id: 'rev-1',
        event_id: 'event-1',
        changeset: {
          title: { old: 'Old', new: 'New Title' },
          price_min: { old: 10, new: 20 },
        },
        status: 'approved',
      };

      const mockEvent = {
        id: 'event-1',
        title: 'Old',
        price_min: 10,
      };

      (prisma.eventRevision.findUnique as any).mockResolvedValue(mockRevision);
      (prisma.canonicalEvent.findUnique as any).mockResolvedValue(mockEvent);
      (prisma.canonicalEvent.update as any).mockResolvedValue({
        ...mockEvent,
        title: 'New Title',
        price_min: 20,
      });

      const result = await applyRevision('rev-1');

      expect(prisma.canonicalEvent.update).toHaveBeenCalledWith({
        where: { id: 'event-1' },
        data: expect.objectContaining({
          title: 'New Title',
          price_min: 20,
        }),
      });

      expect(result.success).toBe(true);
    });

    it('should fail for non-approved revisions', async () => {
      (prisma.eventRevision.findUnique as any).mockResolvedValue({
        id: 'rev-1',
        status: 'pending',
      });

      await expect(applyRevision('rev-1')).rejects.toThrow(/not approved/i);
    });
  });

  describe('hasConflicts', () => {
    it('should detect conflicts with current event state', () => {
      const changeset = {
        title: { old: 'Original', new: 'Updated' },
      };

      const currentEvent = {
        title: 'Changed by someone else',
      };

      const result = hasConflicts(changeset, currentEvent);

      expect(result.hasConflicts).toBe(true);
      expect(result.conflictingFields).toContain('title');
    });

    it('should not report conflicts when original matches', () => {
      const changeset = {
        title: { old: 'Original', new: 'Updated' },
      };

      const currentEvent = {
        title: 'Original',
      };

      const result = hasConflicts(changeset, currentEvent);

      expect(result.hasConflicts).toBe(false);
      expect(result.conflictingFields).toHaveLength(0);
    });

    it('should handle multiple fields', () => {
      const changeset = {
        title: { old: 'Title', new: 'New Title' },
        price_min: { old: 10, new: 20 },
        description_short: { old: 'Desc', new: 'New Desc' },
      };

      const currentEvent = {
        title: 'Changed Title', // conflict
        price_min: 10, // no conflict
        description_short: 'Changed Desc', // conflict
      };

      const result = hasConflicts(changeset, currentEvent);

      expect(result.hasConflicts).toBe(true);
      expect(result.conflictingFields).toEqual(['title', 'description_short']);
    });
  });
});
