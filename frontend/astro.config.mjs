import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';

// https://astro.build/config
export default defineConfig({
  site: 'https://familien-lokal.de',
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true }
  }),
  server: {
    port: 3000,
    host: true
  }
});
