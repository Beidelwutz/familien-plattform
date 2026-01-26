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
    
    # AI APIs
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    
    # AI Budget
    ai_daily_limit_usd: float = 10.0
    ai_monthly_limit_usd: float = 200.0
    
    # Geocoding
    nominatim_user_agent: str = "familien-lokal-dev"
    
    # Location defaults (Karlsruhe)
    default_lat: float = 49.0069
    default_lng: float = 8.4037
    default_radius_km: int = 30
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
