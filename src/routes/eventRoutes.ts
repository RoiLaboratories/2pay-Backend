import express, { Request, Response } from 'express';
import { EventPollingService } from '../services/eventPollingService';
import { logger } from '../config/logger';

const router = express.Router();
const eventPollingService = new EventPollingService();

// Start event polling when routes are initialized
eventPollingService.start().catch(error => {
  logger.error('Failed to start event polling service:', error);
});

// Get the last processed block
router.get('/lastBlock', async (_req: Request, res: Response) => {
  try {
    const lastBlock = await eventPollingService.getLastProcessedBlock();
    res.json({ lastProcessedBlock: lastBlock });
  } catch (error) {
    logger.error('Error getting last processed block:', error);
    res.status(500).json({ error: 'Failed to get last processed block' });
  }
});

// Force a poll for events
router.post('/poll', async (_req: Request, res: Response) => {
  try {
    const lastBlock = await eventPollingService.getLastProcessedBlock();
    res.json({ message: 'Polling started', lastProcessedBlock: lastBlock });
  } catch (error) {
    logger.error('Error initiating polling:', error);
    res.status(500).json({ error: 'Failed to initiate polling' });
  }
});

// Clean up on application shutdown
process.on('SIGTERM', () => {
  eventPollingService.stop();
});

process.on('SIGINT', () => {
  eventPollingService.stop();
});

export default router;
