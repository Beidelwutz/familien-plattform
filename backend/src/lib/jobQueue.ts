/**
 * Simple Database-based Job Queue
 * 
 * Features:
 * - Idempotent job creation (unique job_type + job_key)
 * - Status tracking (QUEUED, RUNNING, SUCCESS, FAILED)
 * - Priority-based ordering
 * - Simple dequeue with status update
 * 
 * Note: For production with multiple instances, consider using Redis-based
 * locking or a proper job queue like BullMQ.
 */

import { prisma } from './prisma.js';
import { JobStatus } from '@prisma/client';

export { JobStatus };

export interface JobPayload {
  [key: string]: any;
}

export interface CreateJobOptions {
  jobType: string;
  jobKey: string;  // Unique key for deduplication (e.g., sourceId + dateString)
  payload: JobPayload;
  priority?: number;  // Higher = sooner
  scheduledAt?: Date;
  createdById?: string;
}

export interface JobResult {
  success: boolean;
  data?: any;
  error?: string;
}

// ============================================
// JOB CREATION
// ============================================

/**
 * Create a job (idempotent - returns existing job if key exists)
 */
export async function createJob(options: CreateJobOptions) {
  const {
    jobType,
    jobKey,
    payload,
    priority = 0,
    scheduledAt = new Date(),
    createdById,
  } = options;

  // Check for existing job with same key
  const existing = await prisma.jobQueueEntry.findUnique({
    where: { job_type_job_key: { job_type: jobType, job_key: jobKey } },
  });

  if (existing) {
    // If job exists and is not terminal, return it (idempotent)
    if (existing.status === 'QUEUED' || existing.status === 'RUNNING') {
      return { created: false, job: existing };
    }
    
    // If job failed or succeeded, we could allow re-creation
    // For now, return the existing one
    return { created: false, job: existing };
  }

  const job = await prisma.jobQueueEntry.create({
    data: {
      job_type: jobType,
      job_key: jobKey,
      payload,
      priority,
      scheduled_at: scheduledAt,
      created_by_id: createdById,
      status: 'QUEUED',
    },
  });

  return { created: true, job };
}

/**
 * Create a job only if no similar job is pending/running
 * Useful for preventing duplicate fetches
 */
export async function createJobIfNotExists(options: CreateJobOptions) {
  const { jobType, jobKey } = options;

  const existing = await prisma.jobQueueEntry.findFirst({
    where: {
      job_type: jobType,
      job_key: jobKey,
      status: { in: ['QUEUED', 'RUNNING'] },
    },
  });

  if (existing) {
    return { created: false, job: existing, reason: 'already_pending' };
  }

  return createJob(options);
}

// ============================================
// JOB RETRIEVAL
// ============================================

/**
 * Get the next job to process (by priority and scheduled time)
 * Also marks it as RUNNING
 */
export async function dequeueJob(jobType?: string) {
  // Find the next eligible job
  const job = await prisma.jobQueueEntry.findFirst({
    where: {
      status: 'QUEUED',
      scheduled_at: { lte: new Date() },
      ...(jobType && { job_type: jobType }),
    },
    orderBy: [
      { priority: 'desc' },
      { scheduled_at: 'asc' },
      { created_at: 'asc' },
    ],
  });

  if (!job) {
    return null;
  }

  // Mark as running (optimistic - in production, use SELECT FOR UPDATE)
  const updated = await prisma.jobQueueEntry.updateMany({
    where: {
      id: job.id,
      status: 'QUEUED', // Only update if still queued (prevent race)
    },
    data: {
      status: 'RUNNING',
      started_at: new Date(),
      attempts: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    // Another worker grabbed it, try again
    return dequeueJob(jobType);
  }

  return prisma.jobQueueEntry.findUnique({ where: { id: job.id } });
}

/**
 * Get a specific job by ID
 */
export async function getJob(jobId: string) {
  return prisma.jobQueueEntry.findUnique({ where: { id: jobId } });
}

/**
 * Get job by type and key
 */
export async function getJobByKey(jobType: string, jobKey: string) {
  return prisma.jobQueueEntry.findUnique({
    where: { job_type_job_key: { job_type: jobType, job_key: jobKey } },
  });
}

// ============================================
// JOB COMPLETION
// ============================================

/**
 * Mark job as completed successfully
 */
export async function completeJob(jobId: string, result?: any) {
  return prisma.jobQueueEntry.update({
    where: { id: jobId },
    data: {
      status: 'SUCCESS',
      completed_at: new Date(),
      result: result || null,
      error_message: null,
    },
  });
}

/**
 * Mark job as failed
 */
export async function failJob(jobId: string, error: string) {
  return prisma.jobQueueEntry.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      completed_at: new Date(),
      error_message: error,
    },
  });
}

/**
 * Reset a failed job back to queued (for manual retry)
 */
export async function retryJob(jobId: string) {
  return prisma.jobQueueEntry.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      started_at: null,
      completed_at: null,
      error_message: null,
      result: null,
    },
  });
}

// ============================================
// QUEUE STATISTICS
// ============================================

export interface QueueStats {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  byType: Record<string, { queued: number; running: number; failed: number }>;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<QueueStats> {
  const [counts, byType] = await Promise.all([
    prisma.jobQueueEntry.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.jobQueueEntry.groupBy({
      by: ['job_type', 'status'],
      _count: { status: true },
      where: {
        status: { in: ['QUEUED', 'RUNNING', 'FAILED'] },
      },
    }),
  ]);

  const countMap = new Map(counts.map(c => [c.status, c._count.status]));
  
  const byTypeMap: Record<string, any> = {};
  for (const item of byType) {
    if (!byTypeMap[item.job_type]) {
      byTypeMap[item.job_type] = { queued: 0, running: 0, failed: 0 };
    }
    const key = item.status.toLowerCase() as 'queued' | 'running' | 'failed';
    byTypeMap[item.job_type][key] = item._count.status;
  }

  return {
    total: counts.reduce((sum, c) => sum + c._count.status, 0),
    queued: countMap.get('QUEUED') || 0,
    running: countMap.get('RUNNING') || 0,
    success: countMap.get('SUCCESS') || 0,
    failed: countMap.get('FAILED') || 0,
    byType: byTypeMap,
  };
}

/**
 * Get recent jobs for monitoring
 */
export async function getRecentJobs(options: {
  jobType?: string;
  status?: JobStatus;
  limit?: number;
} = {}) {
  const { jobType, status, limit = 50 } = options;

  return prisma.jobQueueEntry.findMany({
    where: {
      ...(jobType && { job_type: jobType }),
      ...(status && { status }),
    },
    orderBy: { created_at: 'desc' },
    take: limit,
  });
}

/**
 * Clean up old completed jobs
 */
export async function cleanupOldJobs(olderThanDays = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const result = await prisma.jobQueueEntry.deleteMany({
    where: {
      status: { in: ['SUCCESS', 'FAILED'] },
      completed_at: { lt: cutoff },
    },
  });

  return result.count;
}

// ============================================
// SOURCE FETCH JOB HELPERS
// ============================================

/**
 * Create a source fetch job
 */
export async function createSourceFetchJob(
  sourceId: string,
  options: { priority?: number; createdById?: string } = {}
) {
  // Use date bucket for key (allows one fetch per source per day by default)
  const today = new Date().toISOString().split('T')[0];
  const jobKey = `${sourceId}:${today}`;

  return createJobIfNotExists({
    jobType: 'source_fetch',
    jobKey,
    payload: { sourceId },
    priority: options.priority || 0,
    createdById: options.createdById,
  });
}

/**
 * Get fetch status for a source
 */
export async function getSourceFetchStatus(sourceId: string) {
  // Get most recent job for this source
  const job = await prisma.jobQueueEntry.findFirst({
    where: {
      job_type: 'source_fetch',
      job_key: { startsWith: `${sourceId}:` },
    },
    orderBy: { created_at: 'desc' },
  });

  if (!job) {
    return { status: 'never_run', lastRun: null };
  }

  return {
    status: job.status.toLowerCase(),
    jobId: job.id,
    lastRun: job.started_at || job.created_at,
    completedAt: job.completed_at,
    error: job.error_message,
    result: job.result,
  };
}
