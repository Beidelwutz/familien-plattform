/**
 * Auth Middleware Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { signToken, verifyToken } from '../../src/middleware/auth.js';

describe('Auth Middleware', () => {
  describe('signToken', () => {
    it('should generate a valid JWT token', () => {
      const payload = {
        sub: 'user-123',
        email: 'test@example.com',
        role: 'parent',
      };

      const token = signToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should include correct payload in token', () => {
      const payload = {
        sub: 'user-456',
        email: 'admin@example.com',
        role: 'admin',
      };

      const token = signToken(payload);
      const decoded = verifyToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(payload.sub);
      expect(decoded?.email).toBe(payload.email);
      expect(decoded?.role).toBe(payload.role);
    });
  });

  describe('verifyToken', () => {
    it('should return payload for valid token', () => {
      const payload = {
        sub: 'user-789',
        email: 'user@test.com',
        role: 'provider',
      };

      const token = signToken(payload);
      const decoded = verifyToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(payload.sub);
    });

    it('should return null for invalid token', () => {
      const decoded = verifyToken('invalid-token');
      expect(decoded).toBeNull();
    });

    it('should return null for empty token', () => {
      const decoded = verifyToken('');
      expect(decoded).toBeNull();
    });

    it('should return null for tampered token', () => {
      const payload = {
        sub: 'user-123',
        email: 'test@example.com',
        role: 'parent',
      };

      const token = signToken(payload);
      // Tamper with the token by changing a character
      const tamperedToken = token.slice(0, -5) + 'xxxxx';
      
      const decoded = verifyToken(tamperedToken);
      expect(decoded).toBeNull();
    });
  });
});
