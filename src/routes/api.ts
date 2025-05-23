import { Router } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { contributionController } from '../controllers/contributionController';
import { poolController } from '../controllers/poolController';

const router = Router();

// Contribution routes
router.post(
  '/contribute',
  async (req: AuthenticatedRequest, res) => {
    await contributionController.registerContribution(req, res);
  }
);

router.get(
  '/contributions/:address',
  async (req: AuthenticatedRequest, res) => {
    await contributionController.getUserContributions(req, res);
  }
);

// Pool routes
router.get(
  '/pools/:tier',
  async (req: AuthenticatedRequest, res) => {
    await poolController.getPoolStatus(req, res);
  }
);

router.get(
  '/pools/:tier/queue',
  async (req: AuthenticatedRequest, res) => {
    await poolController.getPayoutQueue(req, res);
  }
);

// Admin routes
router.post(
  '/admin/trigger-payout',
  async (req: AuthenticatedRequest, res) => {
    await poolController.triggerManualPayout(req, res);
  }
);

export default router; 