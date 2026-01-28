import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  site: 'https://familien-lokal.de',
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true },
    maxDuration: 60
  }),
  integrations: [tailwind()],
  server: {
    port: 3000,
    host: true
  }
});
