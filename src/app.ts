import express from 'express';
import authRoutes from './routes/authRoutes';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { logger } from './config/logger';
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware } from './middleware/auth';
import apiRoutes from './routes/api';
import eventRoutes from './routes/eventRoutes';
import { EventPollingService } from './services/eventPollingService';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// DEBUG: Print all env vars starting with TWO_PAY at startup
Object.keys(process.env)
  .filter((k) => k.startsWith('TWO_PAY'))
  .forEach((k) => {
    // eslint-disable-next-line no-console
    console.log(`[ENV DEBUG] ${k} = '${process.env[k]}'`);
  });

// DEBUG: Print the entire process.env at startup for troubleshooting
console.log('[ENV DEBUG] Full process.env dump:', process.env);

const app = express();

// Trust proxy (Vercel) to get correct client IP for rate limiting
app.set('trust proxy', 1);

// Initialize Supabase client with service role key for backend operations
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!process.env.SUPABASE_URL || !supabaseKey) {
  throw new Error('Missing Supabase URL or service key. Check your environment variables.');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  supabaseKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Initialize event polling service
const eventPollingService = new EventPollingService();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://www.2pay.site']
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['X-CSRF-Token', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Content-Type', 'Date', 'X-Api-Version', 'Authorization']
}));
app.use(express.json());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use('/api/auth', authRoutes);
// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Handle favicon requests
app.get('/favicon.ico', (_req: express.Request, res: express.Response) => res.status(204).end());
app.get('/favicon.png', (_req: express.Request, res: express.Response) => res.status(204).end());

// Health check endpoint
app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', message: '2Pay API is running' });
});

// Routes
app.use('/api', authMiddleware, apiRoutes);
app.use('/api/events', authMiddleware, eventRoutes);

// Error handling
app.use(errorHandler);

// Start event polling service in production with retries
if (process.env.NODE_ENV === 'production') {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 5000; // 5 seconds

  const startEventPolling = async (retryCount = 0) => {
    try {
      await eventPollingService.start();
      logger.info('Event polling service started successfully');
    } catch (error) {
      logger.error('Failed to start event polling service:', error);
      
      if (retryCount < MAX_RETRIES) {
        logger.info(`Retrying event polling service start in ${RETRY_DELAY/1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        setTimeout(() => startEventPolling(retryCount + 1), RETRY_DELAY);
      } else {
        logger.error('Max retries reached for event polling service startup');
      }
    }
  };

  startEventPolling();
}

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

// Export the Express app as the default handler for Vercel
export default app;