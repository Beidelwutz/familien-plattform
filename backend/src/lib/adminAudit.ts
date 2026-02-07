/**
 * Admin Audit Log Helper Functions
 * 
 * Provides easy-to-use functions for logging admin actions
 */

import { Request } from 'express';
import { prisma } from './prisma.js';
import { AuditAction } from '@prisma/client';

export { AuditAction };

interface AuditLogParams {
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityName?: string;
  changes?: Record<string, { old: any; new: any }>;
  metadata?: Record<string, any>;
  req?: Request; // For IP and User-Agent
}

/**
 * Log an admin action to the audit log
 */
export async function logAdminAction(params: AuditLogParams): Promise<void> {
  const {
    userId,
    action,
    entityType,
    entityId,
    entityName,
    changes,
    metadata,
    req,
  } = params;

  try {
    await prisma.adminAuditLog.create({
      data: {
        user_id: userId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: entityName || null,
        changes: changes ?? undefined,
        metadata: metadata ?? undefined,
        ip_address: req ? getClientIp(req) : null,
        user_agent: req?.headers['user-agent']?.substring(0, 500) || null,
      },
    });
  } catch (error) {
    // Log error but don't fail the main operation
    console.error('Failed to write audit log:', error);
  }
}

/**
 * Log a category action
 */
export async function logCategoryAction(
  userId: string,
  action: AuditAction,
  category: { id: string; name_de: string },
  changes?: Record<string, { old: any; new: any }>,
  req?: Request
): Promise<void> {
  await logAdminAction({
    userId,
    action,
    entityType: 'category',
    entityId: category.id,
    entityName: category.name_de,
    changes,
    req,
  });
}

/**
 * Log an amenity action
 */
export async function logAmenityAction(
  userId: string,
  action: AuditAction,
  amenity: { id: string; name_de: string },
  changes?: Record<string, { old: any; new: any }>,
  req?: Request
): Promise<void> {
  await logAdminAction({
    userId,
    action,
    entityType: 'amenity',
    entityId: amenity.id,
    entityName: amenity.name_de,
    changes,
    req,
  });
}

/**
 * Log a batch reorder action
 */
export async function logBatchReorder(
  userId: string,
  entityType: 'category' | 'amenity',
  moves: { id: string; newOrder: number; newParentId?: string | null }[],
  req?: Request
): Promise<void> {
  await logAdminAction({
    userId,
    action: AuditAction.REORDER,
    entityType,
    entityId: 'batch',
    entityName: `${moves.length} items reordered`,
    metadata: { moves },
    req,
  });
}

/**
 * Get recent audit logs for an entity
 */
export async function getAuditLogsForEntity(
  entityType: string,
  entityId: string,
  limit = 20
) {
  return prisma.adminAuditLog.findMany({
    where: {
      entity_type: entityType,
      entity_id: entityId,
    },
    include: {
      user: {
        select: { id: true, email: true },
      },
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}

/**
 * Get recent audit logs for a user
 */
export async function getAuditLogsByUser(userId: string, limit = 50) {
  return prisma.adminAuditLog.findMany({
    where: { user_id: userId },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}

/**
 * Get all recent audit logs (admin dashboard)
 */
export async function getRecentAuditLogs(
  options: {
    limit?: number;
    entityType?: string;
    action?: AuditAction;
    userId?: string;
  } = {}
) {
  const { limit = 100, entityType, action, userId } = options;

  return prisma.adminAuditLog.findMany({
    where: {
      ...(entityType && { entity_type: entityType }),
      ...(action && { action }),
      ...(userId && { user_id: userId }),
    },
    include: {
      user: {
        select: { id: true, email: true },
      },
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
}

/**
 * Helper to extract client IP from request
 */
function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
    return ips[0].trim().substring(0, 45);
  }
  return req.socket.remoteAddress?.substring(0, 45) || null;
}

/**
 * Compute changes between old and new objects
 */
export function computeChanges(
  oldObj: Record<string, any>,
  newObj: Record<string, any>,
  fields: string[]
): Record<string, { old: any; new: any }> | undefined {
  const changes: Record<string, { old: any; new: any }> = {};

  for (const field of fields) {
    const oldVal = oldObj[field];
    const newVal = newObj[field];

    if (oldVal !== newVal) {
      changes[field] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}
