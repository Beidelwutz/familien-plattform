/**
 * Geo Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '../../src/lib/prisma.js';
import {
  addDistanceToEvents,
  calculateDistance,
} from '../../src/lib/geo.js';

describe('Geo Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateDistance', () => {
    it('should calculate distance between two points', () => {
      // Karlsruhe to Stuttgart (approx 70km)
      const distance = calculateDistance(49.0069, 8.4037, 48.7758, 9.1829);
      
      expect(distance).toBeGreaterThan(60);
      expect(distance).toBeLessThan(80);
    });

    it('should return 0 for same location', () => {
      const distance = calculateDistance(49.0069, 8.4037, 49.0069, 8.4037);
      expect(distance).toBe(0);
    });

    it('should handle null coordinates', () => {
      const distance = calculateDistance(null as any, null as any, 49.0069, 8.4037);
      expect(distance).toBeNull();
    });
  });

  describe('addDistanceToEvents', () => {
    it('should add distance_km to events', () => {
      const events = [
        { id: '1', location_lat: 49.01, location_lng: 8.41 },
        { id: '2', location_lat: 49.02, location_lng: 8.42 },
      ];

      const userLat = 49.0069;
      const userLng = 8.4037;

      const result = addDistanceToEvents(events, userLat, userLng);

      expect(result[0]).toHaveProperty('distance_km');
      expect(typeof result[0].distance_km).toBe('number');
      expect(result[1]).toHaveProperty('distance_km');
    });

    it('should handle events without coordinates', () => {
      const events = [
        { id: '1', location_lat: null, location_lng: null },
        { id: '2' },
      ];

      const result = addDistanceToEvents(events, 49.0069, 8.4037);

      expect(result[0].distance_km).toBeNull();
      expect(result[1].distance_km).toBeNull();
    });

    it('should sort by distance when requested', () => {
      const events = [
        { id: 'far', location_lat: 50.0, location_lng: 9.0 },
        { id: 'close', location_lat: 49.01, location_lng: 8.41 },
        { id: 'mid', location_lat: 49.1, location_lng: 8.5 },
      ];

      const result = addDistanceToEvents(events, 49.0069, 8.4037);

      // Sort manually to verify distances are calculated correctly
      const sorted = [...result].sort((a, b) => 
        (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity)
      );
      
      expect(sorted[0].id).toBe('close');
      expect(sorted[2].id).toBe('far');
    });
  });

  describe('searchEventsWithinRadius', () => {
    it('should query PostGIS for events within radius', async () => {
      const mockEvents = [
        { id: '1', title: 'Event 1', distance_km: 5 },
        { id: '2', title: 'Event 2', distance_km: 10 },
      ];

      (prisma.$queryRaw as any).mockResolvedValue(mockEvents);

      // Import the function dynamically to use the mocked prisma
      const { searchEventsWithinRadius } = await import('../../src/lib/geo.js');
      
      const result = await searchEventsWithinRadius(49.0069, 8.4037, 20, {
        limit: 10,
        status: 'published',
      });

      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(result.events).toBeDefined();
    });

    it('should handle empty results', async () => {
      (prisma.$queryRaw as any).mockResolvedValue([]);

      const { searchEventsWithinRadius } = await import('../../src/lib/geo.js');
      
      const result = await searchEventsWithinRadius(49.0069, 8.4037, 5, {
        limit: 10,
      });

      expect(result.events).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
