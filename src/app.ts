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
import { EventListener } from './services/eventListener';

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

// Initialize event listener
const eventListener = new EventListener();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://2pay.site', 'https://www.2pay.site']
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
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

// Routes
app.use('/api', authMiddleware, apiRoutes);

// Error handling
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// Start the server and event listener
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  try {
    await eventListener.start();
    logger.info('Event listener started successfully');
  } catch (error) {
    logger.error('Failed to start event listener:', error);
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  eventListener.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  eventListener.stop();
  process.exit(0);
});