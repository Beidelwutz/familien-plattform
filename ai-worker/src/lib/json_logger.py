"""Structured JSON logging for better observability.

Outputs logs in JSON format for easy parsing by log aggregation tools.
"""

import json
import logging
import sys
from datetime import datetime
from typing import Any, Optional

from .pii_redactor import PIIRedactor


class JSONFormatter(logging.Formatter):
    """Format log records as JSON with structured fields."""
    
    def __init__(self, redact_pii: bool = True):
        super().__init__()
        self.redact_pii = redact_pii
    
    def format(self, record: logging.LogRecord) -> str:
        """Format the log record as JSON."""
        # Base log object
        log_obj = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": self._redact(record.getMessage()),
        }
        
        # Add standard fields if present
        standard_fields = [
            "job_id", "run_id", "source_id", "event_id",
            "stage", "duration_ms", "status", "error_code",
            "fingerprint", "queue", "attempts"
        ]
        
        for field in standard_fields:
            value = getattr(record, field, None)
            if value is not None:
                log_obj[field] = value
        
        # Add exception info if present
        if record.exc_info:
            log_obj["exception"] = {
                "type": record.exc_info[0].__name__ if record.exc_info[0] else None,
                "message": str(record.exc_info[1]) if record.exc_info[1] else None,
                "traceback": self.formatException(record.exc_info),
            }
        
        # Add any extra fields from the record
        for key, value in record.__dict__.items():
            if key not in ['name', 'msg', 'args', 'created', 'filename', 'funcName',
                          'levelname', 'levelno', 'lineno', 'module', 'msecs',
                          'pathname', 'process', 'processName', 'relativeCreated',
                          'stack_info', 'exc_info', 'exc_text', 'thread', 'threadName',
                          'message', 'asctime'] and not key.startswith('_'):
                if key not in standard_fields:
                    log_obj[key] = self._redact(value) if isinstance(value, str) else value
        
        return json.dumps(log_obj, default=str, ensure_ascii=False)
    
    def _redact(self, text: Any) -> Any:
        """Redact PII from text if enabled."""
        if not self.redact_pii or not isinstance(text, str):
            return text
        return PIIRedactor.redact_for_logging(text)


class StructuredLoggerAdapter(logging.LoggerAdapter):
    """Logger adapter that adds structured context to all log messages."""
    
    def __init__(self, logger: logging.Logger, extra: Optional[dict] = None):
        super().__init__(logger, extra or {})
    
    def process(self, msg, kwargs):
        """Add extra context to log record."""
        extra = kwargs.get('extra', {})
        extra.update(self.extra)
        kwargs['extra'] = extra
        return msg, kwargs
    
    def with_context(self, **context) -> 'StructuredLoggerAdapter':
        """Create a new adapter with additional context."""
        new_extra = {**self.extra, **context}
        return StructuredLoggerAdapter(self.logger, new_extra)


def setup_json_logging(level: str = "INFO", redact_pii: bool = True):
    """
    Configure root logger for JSON output.
    
    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        redact_pii: Whether to redact PII from logs
    """
    # Create JSON formatter
    formatter = JSONFormatter(redact_pii=redact_pii)
    
    # Configure handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    
    # Remove existing handlers
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    
    # Set level for common noisy loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def get_structured_logger(name: str, **context) -> StructuredLoggerAdapter:
    """
    Get a structured logger with optional context.
    
    Args:
        name: Logger name
        **context: Default context fields (job_id, run_id, etc.)
        
    Returns:
        StructuredLoggerAdapter with context
    """
    logger = logging.getLogger(name)
    return StructuredLoggerAdapter(logger, context)


# Convenience function for job-scoped logging
def job_logger(
    job_id: str,
    job_type: str,
    source_id: Optional[str] = None
) -> StructuredLoggerAdapter:
    """Create a logger pre-configured for a specific job."""
    return get_structured_logger(
        f"worker.{job_type}",
        job_id=job_id,
        job_type=job_type,
        source_id=source_id
    )
