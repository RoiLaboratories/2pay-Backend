import express from 'express';
import authRoutes from './routes/authRoutes';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { logger } from './config/logger';
import { errorHandler } from './middleware/errorHandler';
import { authMiddleware } from './middleware/auth';
import apiRoutes from './routes/api';
import { EventListener } from './services/eventListener';

dotenv.config();

const app = express();

// Initialize Supabase client
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// Initialize event listener
const eventListener = new EventListener();

// Middleware
app.use(helmet());
app.use(cors());
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