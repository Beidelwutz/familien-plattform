/**
 * Error Handler Middleware Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { createError, errorHandler, AppError } from '../../src/middleware/errorHandler.js';

describe('Error Handler Middleware', () => {
  describe('createError', () => {
    it('should create an AppError with correct properties', () => {
      const error = createError('Test error', 404, 'NOT_FOUND');

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error');
      expect((error as AppError).statusCode).toBe(404);
      expect((error as AppError).code).toBe('NOT_FOUND');
    });

    it('should default to 500 status code', () => {
      const error = createError('Server error');

      expect((error as AppError).statusCode).toBe(500);
    });

    it('should default to INTERNAL_ERROR code', () => {
      const error = createError('Server error');

      expect((error as AppError).code).toBe('INTERNAL_ERROR');
    });
  });

  describe('errorHandler', () => {
    it('should respond with correct status and error format', () => {
      const mockReq = {} as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        headersSent: false,
      } as unknown as Response;
      const mockNext = vi.fn() as NextFunction;

      const error = createError('Resource not found', 404, 'NOT_FOUND');

      errorHandler(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: {
          message: 'Resource not found',
          code: 'NOT_FOUND',
        },
      });
    });

    it('should handle standard Error objects', () => {
      const mockReq = {} as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        headersSent: false,
      } as unknown as Response;
      const mockNext = vi.fn() as NextFunction;

      const error = new Error('Standard error');

      errorHandler(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: {
          message: 'Standard error',
          code: 'INTERNAL_ERROR',
        },
      });
    });

    it('should not send response if headers already sent', () => {
      const mockReq = {} as Request;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        headersSent: true,
      } as unknown as Response;
      const mockNext = vi.fn() as NextFunction;

      const error = createError('Error');

      errorHandler(error, mockReq, mockRes, mockNext);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
