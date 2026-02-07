// Deploy test 2026-02-06
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { apiLimiter } from './middleware/rateLimit.js';

// Routes
import healthRoutes from './routes/health.js';
import eventsRoutes from './routes/events.js';
import sourcesRoutes from './routes/sources.js';
import planRoutes from './routes/plan.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import searchRoutes from './routes/search.js';
import adminTrendsRoutes from './routes/adminTrends.js';
import providersRoutes from './routes/providers.js';
import categoriesRoutes from './routes/categories.js';
import amenitiesRoutes from './routes/amenities.js';
import aiUsageRoutes from './routes/aiUsage.js';

const app = express();
const PORT = process.env.PORT || 4000;

// CORS: allow single origin or comma-separated list (Frontend 3000/3001, Vercel preview + production)
const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://www.kiezling.com',
  'https://kiezling.com',
  'https://familien-plattform.vercel.app'
];
const corsOrigin = process.env.CORS_ORIGIN;
const corsOrigins = corsOrigin 
  ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
  : defaultCorsOrigins;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // Tailwind needs inline styles
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", ...corsOrigins],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,  // Allow loading external images
}));
app.use(cors({
  origin: corsOrigins.length > 1 ? corsOrigins : corsOrigins[0] || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-API-Key'],
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(correlationMiddleware);
app.use(apiLimiter);

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/categories', categoriesRoutes);
app.use('/api/admin/amenities', amenitiesRoutes);
app.use('/api/admin/ai-usage', aiUsageRoutes);
app.use('/api/ai', aiUsageRoutes);  // For AI worker log ingestion
app.use('/api/search', searchRoutes);
app.use('/api/admin/trends', adminTrendsRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server (only when not running as serverless function)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  });
}

export default app;
