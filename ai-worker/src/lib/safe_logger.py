"""Safe logging utilities with PII redaction.

Ensures sensitive data is never logged in plaintext.
"""

import logging
from typing import Any, Optional
from functools import lru_cache

from .pii_redactor import PIIRedactor


class SafeLogger:
    """Logger wrapper that automatically redacts PII from messages."""
    
    def __init__(self, name: str, level: int = logging.INFO):
        self._logger = logging.getLogger(name)
        self._logger.setLevel(level)
    
    def _redact(self, msg: Any) -> str:
        """Redact PII from message."""
        return PIIRedactor.redact_for_logging(str(msg))
    
    def _format_extra(self, **kwargs) -> dict:
        """Redact PII from extra fields."""
        redacted = {}
        for key, value in kwargs.items():
            if isinstance(value, str):
                redacted[key] = PIIRedactor.redact_for_logging(value)
            else:
                redacted[key] = value
        return redacted
    
    def debug(self, msg: Any, *args, **kwargs):
        """Log debug message with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.debug(self._redact(msg), *args, extra=extra, **kwargs)
    
    def info(self, msg: Any, *args, **kwargs):
        """Log info message with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.info(self._redact(msg), *args, extra=extra, **kwargs)
    
    def warning(self, msg: Any, *args, **kwargs):
        """Log warning message with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.warning(self._redact(msg), *args, extra=extra, **kwargs)
    
    def error(self, msg: Any, *args, **kwargs):
        """Log error message with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.error(self._redact(msg), *args, extra=extra, **kwargs)
    
    def critical(self, msg: Any, *args, **kwargs):
        """Log critical message with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.critical(self._redact(msg), *args, extra=extra, **kwargs)
    
    def exception(self, msg: Any, *args, **kwargs):
        """Log exception with PII redaction."""
        extra = self._format_extra(**kwargs.pop('extra', {}))
        self._logger.exception(self._redact(msg), *args, extra=extra, **kwargs)
    
    @property
    def level(self) -> int:
        return self._logger.level
    
    def setLevel(self, level: int):
        self._logger.setLevel(level)
    
    def addHandler(self, handler: logging.Handler):
        self._logger.addHandler(handler)


@lru_cache(maxsize=64)
def get_safe_logger(name: str) -> SafeLogger:
    """Get or create a SafeLogger instance."""
    return SafeLogger(name)
