/**
 * Structured logging for the backend
 */

export interface LogContext {
  correlation_id?: string;
  source_id?: string;
  event_id?: string;
  user_id?: string;
  duration_ms?: number;
  action?: string;
  result?: string;
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatLog(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] ${level.toUpperCase()}: ${message}${contextStr}`;
}

export const logger = {
  debug(message: string, context?: LogContext) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(formatLog('debug', message, context));
    }
  },

  info(message: string, context?: LogContext) {
    console.log(formatLog('info', message, context));
  },

  warn(message: string, context?: LogContext) {
    console.warn(formatLog('warn', message, context));
  },

  error(message: string, context?: LogContext) {
    console.error(formatLog('error', message, context));
  },
};

/**
 * Creates a child logger with preset context
 */
export function createChildLogger(baseContext: LogContext) {
  return {
    debug(message: string, context?: LogContext) {
      logger.debug(message, { ...baseContext, ...context });
    },
    info(message: string, context?: LogContext) {
      logger.info(message, { ...baseContext, ...context });
    },
    warn(message: string, context?: LogContext) {
      logger.warn(message, { ...baseContext, ...context });
    },
    error(message: string, context?: LogContext) {
      logger.error(message, { ...baseContext, ...context });
    },
  };
}
