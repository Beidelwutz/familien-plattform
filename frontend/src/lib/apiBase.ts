/**
 * API base URL for backend requests.
 * In production, when PUBLIC_API_URL is not set, assumes backend at https://api.<hostname> (e.g. api.kiezling.com).
 */
export function getApiBase(): string {
  if (import.meta.env.PUBLIC_API_URL) return import.meta.env.PUBLIC_API_URL;
  if (import.meta.env.DEV) return 'http://localhost:4000';
  if (typeof window !== 'undefined') return `https://api.${window.location.hostname}`;
  return 'https://api.kiezling.com';
}
