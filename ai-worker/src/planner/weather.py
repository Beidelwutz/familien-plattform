"""Weather provider using Open-Meteo API (free, no key required).

Provides weather forecasts for plan generation.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional
import logging
import json

import httpx

logger = logging.getLogger(__name__)

# Weather code mappings (WMO codes)
WEATHER_CODES = {
    0: ("clear", "Klar"),
    1: ("mostly_clear", "Überwiegend klar"),
    2: ("partly_cloudy", "Teilweise bewölkt"),
    3: ("overcast", "Bedeckt"),
    45: ("fog", "Nebel"),
    48: ("fog", "Nebel mit Reif"),
    51: ("drizzle", "Leichter Nieselregen"),
    53: ("drizzle", "Nieselregen"),
    55: ("drizzle", "Starker Nieselregen"),
    61: ("rain", "Leichter Regen"),
    63: ("rain", "Regen"),
    65: ("rain", "Starker Regen"),
    66: ("freezing_rain", "Gefrierender Regen"),
    67: ("freezing_rain", "Starker gefrierender Regen"),
    71: ("snow", "Leichter Schnee"),
    73: ("snow", "Schnee"),
    75: ("snow", "Starker Schnee"),
    77: ("snow", "Schneegriesel"),
    80: ("showers", "Leichte Regenschauer"),
    81: ("showers", "Regenschauer"),
    82: ("showers", "Starke Regenschauer"),
    85: ("snow_showers", "Leichte Schneeschauer"),
    86: ("snow_showers", "Schneeschauer"),
    95: ("thunderstorm", "Gewitter"),
    96: ("thunderstorm", "Gewitter mit leichtem Hagel"),
    99: ("thunderstorm", "Gewitter mit starkem Hagel"),
}


@dataclass
class WeatherForecast:
    """Weather forecast for a specific day."""
    date: date
    weather_code: int
    weather_type: str
    weather_description: str
    temperature_max: float
    temperature_min: float
    precipitation_probability: int
    is_good_for_outdoor: bool
    recommendation: str
    
    @classmethod
    def from_api_response(cls, forecast_date: date, data: dict, index: int) -> 'WeatherForecast':
        """Create from Open-Meteo API response."""
        weather_code = data.get("daily", {}).get("weathercode", [0])[index]
        weather_info = WEATHER_CODES.get(weather_code, ("unknown", "Unbekannt"))
        
        temp_max = data.get("daily", {}).get("temperature_2m_max", [20])[index]
        temp_min = data.get("daily", {}).get("temperature_2m_min", [10])[index]
        precip_prob = data.get("daily", {}).get("precipitation_probability_max", [0])[index]
        
        # Determine if good for outdoor
        bad_weather_types = ["rain", "showers", "snow", "snow_showers", "thunderstorm", "freezing_rain"]
        is_outdoor_ok = (
            weather_info[0] not in bad_weather_types and
            precip_prob < 50 and
            temp_max > 5
        )
        
        # Generate recommendation
        if weather_info[0] in ["clear", "mostly_clear", "partly_cloudy"]:
            recommendation = "Perfektes Wetter für Outdoor-Aktivitäten!"
        elif weather_info[0] == "overcast":
            recommendation = "Bewölkt, aber trocken - Outdoor möglich"
        elif weather_info[0] in bad_weather_types:
            recommendation = "Indoor-Aktivitäten empfohlen"
        else:
            recommendation = "Wetterabhängig - Plan B bereithalten"
        
        return cls(
            date=forecast_date,
            weather_code=weather_code,
            weather_type=weather_info[0],
            weather_description=weather_info[1],
            temperature_max=temp_max,
            temperature_min=temp_min,
            precipitation_probability=precip_prob,
            is_good_for_outdoor=is_outdoor_ok,
            recommendation=recommendation,
        )
    
    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "date": self.date.isoformat(),
            "weather_code": self.weather_code,
            "weather_type": self.weather_type,
            "weather_description": self.weather_description,
            "temperature_max": self.temperature_max,
            "temperature_min": self.temperature_min,
            "precipitation_probability": self.precipitation_probability,
            "is_good_for_outdoor": self.is_good_for_outdoor,
            "recommendation": self.recommendation,
        }


class WeatherProvider:
    """Weather forecast provider using Open-Meteo API."""
    
    BASE_URL = "https://api.open-meteo.com/v1/forecast"
    CACHE_TTL_SECONDS = 3600  # 1 hour
    
    def __init__(self):
        self._cache: dict[str, tuple[datetime, WeatherForecast]] = {}
        self.client = httpx.AsyncClient(timeout=10.0)
    
    def _cache_key(self, target_date: date, lat: float, lng: float) -> str:
        """Generate cache key."""
        return f"weather:{target_date.isoformat()}:{lat:.2f}:{lng:.2f}"
    
    async def get_forecast(
        self,
        target_date: date,
        lat: float,
        lng: float
    ) -> Optional[WeatherForecast]:
        """
        Get weather forecast for a specific date and location.
        
        Args:
            target_date: Date to get forecast for
            lat: Latitude
            lng: Longitude
            
        Returns:
            WeatherForecast or None if unavailable
        """
        # Check cache
        cache_key = self._cache_key(target_date, lat, lng)
        if cache_key in self._cache:
            cached_time, forecast = self._cache[cache_key]
            if (datetime.utcnow() - cached_time).seconds < self.CACHE_TTL_SECONDS:
                logger.debug(f"Weather cache hit: {cache_key}")
                return forecast
        
        # Calculate days from today
        days_ahead = (target_date - date.today()).days
        if days_ahead < 0 or days_ahead > 14:
            logger.warning(f"Weather forecast not available for {target_date} (outside 14-day range)")
            return None
        
        try:
            # Fetch from API
            params = {
                "latitude": lat,
                "longitude": lng,
                "daily": "weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "timezone": "Europe/Berlin",
                "forecast_days": min(days_ahead + 1, 14),
            }
            
            response = await self.client.get(self.BASE_URL, params=params)
            response.raise_for_status()
            data = response.json()
            
            # Find the right index for the target date
            dates = data.get("daily", {}).get("time", [])
            target_str = target_date.isoformat()
            
            if target_str in dates:
                index = dates.index(target_str)
                forecast = WeatherForecast.from_api_response(target_date, data, index)
                
                # Cache result
                self._cache[cache_key] = (datetime.utcnow(), forecast)
                
                logger.info(f"Weather forecast for {target_date}: {forecast.weather_description}, {forecast.temperature_max}°C")
                return forecast
            
            logger.warning(f"Target date {target_date} not found in API response")
            return None
            
        except Exception as e:
            logger.error(f"Failed to get weather forecast: {e}")
            return None
    
    async def close(self):
        """Close HTTP client."""
        await self.client.aclose()


# Global instance
weather_provider = WeatherProvider()
