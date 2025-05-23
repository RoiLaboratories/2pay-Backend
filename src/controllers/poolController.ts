import { Response } from 'express';
import { ethers } from 'ethers';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';

const TWO_PAY_ADDRESS = process.env.TWO_PAY_CONTRACT_ADDRESS!;
const TWO_PAY_ABI = require('../../contracts/TwoPay.json').abi;

export const poolController = {
  async getPoolStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { tier } = req.params;
      const tierNum = parseInt(tier);

      if (isNaN(tierNum) || tierNum < 1 || tierNum > 3) {
        throw new AppError(400, 'Invalid tier');
      }

      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const contract = new ethers.Contract(TWO_PAY_ADDRESS, TWO_PAY_ABI, provider);

      const [currentBatch, contributorsInBatch, nextPayoutIndex] = 
        await contract.getPoolStatus(tierNum);

      res.json({
        status: 'success',
        data: {
          tier: tierNum,
          currentBatch: currentBatch.toString(),
          contributorsInBatch: contributorsInBatch.toString(),
          nextPayoutIndex: nextPayoutIndex.toString()
        }
      });
    } catch (error) {
      logger.error('Get pool status error:', error);
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          status: 'error',
          message: error.message
        });
      } else {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get pool status'
        });
      }
    }
  },

  async getPayoutQueue(req: AuthenticatedRequest, res: Response) {
    try {
      const { tier } = req.params;
      const tierNum = parseInt(tier);

      if (isNaN(tierNum) || tierNum < 1 || tierNum > 3) {
        throw new AppError(400, 'Invalid tier');
      }

      const { data, error } = await supabase
        .from('contributions')
        .select('*')
        .eq('tier', tierNum)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (error) {
        throw new AppError(500, 'Failed to fetch payout queue');
      }

      res.json({
        status: 'success',
        data
      });
    } catch (error) {
      logger.error('Get payout queue error:', error);
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          status: 'error',
          message: error.message
        });
      } else {
        res.status(500).json({
          status: 'error',
          message: 'Failed to get payout queue'
        });
      }
    }
  },

  async triggerManualPayout(req: AuthenticatedRequest, res: Response) {
    try {
      const { tier } = req.body;
      const tierNum = parseInt(tier);

      if (isNaN(tierNum) || tierNum < 1 || tierNum > 3) {
        throw new AppError(400, 'Invalid tier');
      }

      // Verify admin status
      const { data: user } = await supabase
        .from('users')
        .select('is_admin')
        .eq('wallet_address', req.user?.address)
        .single();

      if (!user?.is_admin) {
        throw new AppError(403, 'Unauthorized');
      }

      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY!, provider);
      const contract = new ethers.Contract(TWO_PAY_ADDRESS, TWO_PAY_ABI, wallet);

      const tx = await contract.contribute(tierNum);
      await tx.wait();

      res.json({
        status: 'success',
        data: {
          transactionHash: tx.hash
        }
      });
    } catch (error) {
      logger.error('Trigger manual payout error:', error);
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          status: 'error',
          message: error.message
        });
      } else {
        res.status(500).json({
          status: 'error',
          message: 'Failed to trigger manual payout'
        });
      }
    }
  }
}; 