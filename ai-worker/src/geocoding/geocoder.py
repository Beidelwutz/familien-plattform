"""Geocoding service for address to coordinates conversion."""

from dataclasses import dataclass
from typing import Optional
import hashlib
import asyncio
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderServiceError

from src.config import get_settings


@dataclass
class GeocodingResult:
    """Result of geocoding."""
    lat: float
    lng: float
    confidence: float
    normalized_address: str
    district: Optional[str]
    provider: str


class Geocoder:
    """Geocoding service with caching."""
    
    def __init__(self):
        self.settings = get_settings()
        self._cache: dict[str, GeocodingResult] = {}
        self._nominatim = Nominatim(
            user_agent=self.settings.nominatim_user_agent,
            timeout=10
        )
    
    async def geocode(self, address: str) -> Optional[GeocodingResult]:
        """
        Geocode an address to coordinates.
        
        Args:
            address: Address string to geocode
            
        Returns:
            GeocodingResult or None if not found
        """
        if not address or len(address.strip()) < 5:
            return None
        
        # Normalize address
        address_norm = self._normalize_address(address)
        
        # Check cache
        cache_key = self._cache_key(address_norm)
        if cache_key in self._cache:
            return self._cache[cache_key]
        
        # Try geocoding
        result = await self._geocode_nominatim(address_norm)
        
        if result:
            self._cache[cache_key] = result
        
        return result
    
    async def _geocode_nominatim(self, address: str) -> Optional[GeocodingResult]:
        """Geocode using Nominatim (OpenStreetMap)."""
        try:
            # Run in executor since geopy is synchronous
            loop = asyncio.get_event_loop()
            location = await loop.run_in_executor(
                None,
                lambda: self._nominatim.geocode(
                    address,
                    addressdetails=True,
                    language='de'
                )
            )
            
            if not location:
                return None
            
            # Extract district from address details
            district = None
            if hasattr(location, 'raw') and 'address' in location.raw:
                addr = location.raw['address']
                district = addr.get('suburb') or addr.get('neighbourhood') or addr.get('city_district')
            
            # Calculate confidence based on result type
            confidence = self._calculate_confidence(location)
            
            return GeocodingResult(
                lat=location.latitude,
                lng=location.longitude,
                confidence=confidence,
                normalized_address=location.address,
                district=district,
                provider='nominatim'
            )
            
        except (GeocoderTimedOut, GeocoderServiceError) as e:
            print(f"Geocoding error: {e}")
            return None
        except Exception as e:
            print(f"Unexpected geocoding error: {e}")
            return None
    
    def _normalize_address(self, address: str) -> str:
        """Normalize address for better matching."""
        # Basic normalization
        address = address.strip()
        
        # Add Karlsruhe if not present and looks like a local address
        if 'karlsruhe' not in address.lower() and 'ka-' not in address.lower():
            if any(char.isdigit() for char in address):  # Looks like street address
                address = f"{address}, Karlsruhe, Deutschland"
        
        return address
    
    def _calculate_confidence(self, location) -> float:
        """Calculate confidence score based on result type."""
        if not hasattr(location, 'raw'):
            return 0.5
        
        result_type = location.raw.get('type', '')
        
        # High confidence for exact matches
        if result_type in ['house', 'building', 'residential']:
            return 0.95
        
        # Medium confidence for streets
        if result_type in ['street', 'road', 'highway']:
            return 0.75
        
        # Lower confidence for areas
        if result_type in ['suburb', 'neighbourhood', 'city']:
            return 0.5
        
        return 0.6
    
    def _cache_key(self, address: str) -> str:
        """Generate cache key for address."""
        return hashlib.md5(address.lower().encode()).hexdigest()
    
    def is_in_region(
        self, 
        lat: float, 
        lng: float, 
        center_lat: float = None, 
        center_lng: float = None,
        radius_km: float = None
    ) -> bool:
        """
        Check if coordinates are within the target region.
        
        Args:
            lat, lng: Coordinates to check
            center_lat, center_lng: Center of region (defaults to Karlsruhe)
            radius_km: Radius in km (defaults from settings)
            
        Returns:
            True if within region
        """
        center_lat = center_lat or self.settings.default_lat
        center_lng = center_lng or self.settings.default_lng
        radius_km = radius_km or self.settings.default_radius_km
        
        # Simple distance calculation (Haversine approximation for small distances)
        from math import radians, cos, sin, sqrt, atan2
        
        R = 6371  # Earth's radius in km
        
        lat1, lng1 = radians(center_lat), radians(center_lng)
        lat2, lng2 = radians(lat), radians(lng)
        
        dlat = lat2 - lat1
        dlng = lng2 - lng1
        
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlng/2)**2
        c = 2 * atan2(sqrt(a), sqrt(1-a))
        
        distance = R * c
        
        return distance <= radius_km
