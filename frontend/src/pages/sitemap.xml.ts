// Dynamic sitemap generation for Astro

export async function GET() {
  // In production, fetch actual events from API
  const staticPages = [
    { url: '/', changefreq: 'daily', priority: 1.0 },
    { url: '/suche', changefreq: 'daily', priority: 0.9 },
    { url: '/plan', changefreq: 'weekly', priority: 0.8 },
    { url: '/login', changefreq: 'monthly', priority: 0.3 },
    { url: '/anbieter', changefreq: 'weekly', priority: 0.5 },
  ];

  const baseUrl = 'https://familien-lokal.de';
  const today = new Date().toISOString().split('T')[0];

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticPages.map(page => `  <url>
    <loc>${baseUrl}${page.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}
