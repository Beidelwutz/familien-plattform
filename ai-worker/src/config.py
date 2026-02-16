"""Configuration settings for AI Worker."""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Database
    database_url: str = "postgresql://familien:familien_dev_password@localhost:5432/familien_lokal"
    
    # Redis
    redis_url: str = "redis://localhost:6379"
    
    # Server
    port: int = 5000
    debug: bool = True
    log_level: str = "INFO"
    log_format: str = "json"  # "json" or "text"
    
    # CORS (comma-separated list of allowed origins)
    cors_origins: str = "http://localhost:3000,http://localhost:4000"
    
    # Backend API
    backend_url: str = "http://localhost:4000"
    service_token: str = ""  # JWT token for service-to-service auth
    
    # AI APIs
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    
    # AI Feature Flags
    enable_ai: bool = True  # Global AI kill switch
    ai_low_cost_mode: bool = True  # Use cheaper/smaller models (gpt-4o-mini); set False for gpt-4o
    ai_max_retries: int = 2  # Max retries for failed AI calls
    
    # AI Budget (nur App-seitig: stoppt Batch bei Überschreitung; OpenAI-Limit separat unter platform.openai.com einstellen)
    ai_daily_limit_usd: float = 50.0
    ai_monthly_limit_usd: float = 200.0
    
    # AI Model Configuration
    openai_model: str = "gpt-4o"  # Strong model for escalation
    openai_model_low_cost: str = "gpt-4o-mini"  # Default model
    anthropic_model: str = "claude-3-haiku-20240307"
    ai_temperature: float = 0.3
    ai_max_tokens: int = 800  # Increased for longer outputs
    
    # Model Escalation (when confidence in gray zone)
    escalate_confidence_min: float = 0.60
    escalate_confidence_max: float = 0.78
    
    # Prompt Versions (for tracking)
    classifier_prompt_version: str = "3.0.0"
    scorer_prompt_version: str = "2.1.0"
    planner_prompt_version: str = "1.0.0"
    
    # Geocoding
    nominatim_user_agent: str = "kiezling-dev"
    
    # Location defaults (Karlsruhe)
    default_lat: float = 49.0069
    default_lng: float = 8.4037
    default_radius_km: int = 30
    
    # Queue settings
    max_concurrent_per_domain: int = 2
    crawl_lock_ttl_seconds: int = 600
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


def clear_settings_cache():
    """Clear settings cache (useful for testing)."""
    get_settings.cache_clear()
