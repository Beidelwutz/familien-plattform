/**
 * Events API Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock prisma before importing the route
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    canonicalEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    eventCategory: {
      findMany: vi.fn(),
    },
    eventScore: {
      findMany: vi.fn(),
    },
    provider: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    category: {
      findMany: vi.fn(),
    },
  },
}));

// Mock geo module
vi.mock('../../src/lib/geo.js', () => ({
  searchEventsWithinRadius: vi.fn().mockResolvedValue({ events: [], total: 0 }),
  addDistanceToEvents: vi.fn((events) => events),
}));

import eventsRouter from '../../src/routes/events.js';
import { prisma } from '../../src/lib/prisma.js';

describe('Events API', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/events', eventsRouter);
    vi.clearAllMocks();
  });

  describe('GET /api/events', () => {
    it('should return paginated events', async () => {
      const mockEvents = [
        {
          id: '1',
          title: 'Test Event',
          start_datetime: new Date('2026-02-01T10:00:00Z'),
          status: 'published',
          categories: [],
          scores: null,
        },
      ];

      (prisma.canonicalEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.canonicalEvent.count as any).mockResolvedValue(1);

      const response = await request(app)
        .get('/api/events')
        .query({ page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        limit: 10,
        total: 1,
      });
    });

    it('should filter by tab=heute', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app)
        .get('/api/events')
        .query({ tab: 'heute' });

      expect(response.status).toBe(200);
      expect(prisma.canonicalEvent.findMany).toHaveBeenCalled();
    });

    it('should filter by indoor=true', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app)
        .get('/api/events')
        .query({ indoor: 'true' });

      expect(response.status).toBe(200);
      const call = (prisma.canonicalEvent.findMany as any).mock.calls[0][0];
      expect(call.where.is_indoor).toBe(true);
    });

    it('should filter by categories', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app)
        .get('/api/events')
        .query({ categories: 'spielplatz,museum' });

      expect(response.status).toBe(200);
      const call = (prisma.canonicalEvent.findMany as any).mock.calls[0][0];
      expect(call.where.categories.some.category.slug.in).toEqual(['spielplatz', 'museum']);
    });

    it('should filter by age range', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app)
        .get('/api/events')
        .query({ ageMin: 3, ageMax: 6 });

      expect(response.status).toBe(200);
      const call = (prisma.canonicalEvent.findMany as any).mock.calls[0][0];
      expect(call.where.age_max.gte).toBe(3);
      expect(call.where.age_min.lte).toBe(6);
    });

    it('should filter by free=true', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app)
        .get('/api/events')
        .query({ free: 'true' });

      expect(response.status).toBe(200);
      const call = (prisma.canonicalEvent.findMany as any).mock.calls[0][0];
      expect(call.where.price_type).toBe('free');
    });
  });

  describe('GET /api/events/:id', () => {
    it('should return event by id', async () => {
      const mockEvent = {
        id: 'test-id',
        title: 'Test Event',
        start_datetime: new Date('2026-02-01T10:00:00Z'),
        categories: [],
        scores: null,
        amenities: [],
        provider: null,
      };

      (prisma.canonicalEvent.findUnique as any).mockResolvedValue(mockEvent);

      const response = await request(app).get('/api/events/test-id');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe('test-id');
    });

    it('should return 404 for non-existent event', async () => {
      (prisma.canonicalEvent.findUnique as any).mockResolvedValue(null);

      const response = await request(app).get('/api/events/non-existent');

      expect(response.status).toBe(404);
    });

    it('should increment view count', async () => {
      const mockEvent = {
        id: 'test-id',
        title: 'Test Event',
        start_datetime: new Date(),
        view_count: 5,
      };

      (prisma.canonicalEvent.findUnique as any).mockResolvedValue(mockEvent);
      (prisma.canonicalEvent.update as any).mockResolvedValue({ ...mockEvent, view_count: 6 });

      await request(app).get('/api/events/test-id');

      expect(prisma.canonicalEvent.update).toHaveBeenCalledWith({
        where: { id: 'test-id' },
        data: { view_count: { increment: 1 } },
      });
    });
  });

  describe('GET /api/events/top-picks', () => {
    it('should return top picks sorted by score', async () => {
      const mockEvents = [
        {
          id: '1',
          title: 'High Score Event',
          scores: { stressfree_score: 90, family_fit_score: 85 },
        },
      ];

      (prisma.canonicalEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.canonicalEvent.count as any).mockResolvedValue(1);

      const response = await request(app).get('/api/events/top-picks');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(prisma.canonicalEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            is_complete: true,
          }),
        })
      );
    });
  });

  describe('GET /api/events/trending', () => {
    it('should return trending events sorted by engagement', async () => {
      (prisma.canonicalEvent.findMany as any).mockResolvedValue([]);
      (prisma.canonicalEvent.count as any).mockResolvedValue(0);

      const response = await request(app).get('/api/events/trending');

      expect(response.status).toBe(200);
      const call = (prisma.canonicalEvent.findMany as any).mock.calls[0][0];
      expect(call.orderBy).toContainEqual({ save_count: 'desc' });
      expect(call.orderBy).toContainEqual({ view_count: 'desc' });
    });
  });

  describe('POST /api/events/:id/cancel', () => {
    it('should cancel an event', async () => {
      const mockEvent = {
        id: 'test-id',
        is_cancelled: false,
        status: 'published',
      };

      (prisma.canonicalEvent.findUnique as any).mockResolvedValue(mockEvent);
      (prisma.canonicalEvent.update as any).mockResolvedValue({
        ...mockEvent,
        is_cancelled: true,
        status: 'cancelled',
      });

      const response = await request(app)
        .post('/api/events/test-id/cancel')
        .send({ reason: 'Weather conditions' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(prisma.canonicalEvent.update).toHaveBeenCalledWith({
        where: { id: 'test-id' },
        data: expect.objectContaining({
          is_cancelled: true,
          status: 'cancelled',
        }),
      });
    });

    it('should return 400 if already cancelled', async () => {
      (prisma.canonicalEvent.findUnique as any).mockResolvedValue({
        id: 'test-id',
        is_cancelled: true,
      });

      const response = await request(app)
        .post('/api/events/test-id/cancel')
        .send({});

      expect(response.status).toBe(400);
    });
  });
});
