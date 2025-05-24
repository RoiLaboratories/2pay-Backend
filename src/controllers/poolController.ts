import { Response } from 'express';
import { ethers } from 'ethers';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';
import TwoPayJson from '../../artifacts/contracts/TwoPay.sol/TwoPay.json';


const TWO_PAY_ADDRESS = process.env.TWO_PAY_CONTRACT_ADDRESS!;
const TWO_PAY_ABI = TwoPayJson.abi;


export const poolController = {
  async getPoolStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { tier } = req.params;
      const tierNum = parseInt(tier);

      if (isNaN(tierNum) || tierNum < 1 || tierNum > 3) {
        throw new AppError(400, 'Invalid tier');
      }

      // Get pool status from contract
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const contract = new ethers.Contract(TWO_PAY_ADDRESS, TWO_PAY_ABI, provider);

      const [currentBatch, contributorsInBatch, nextPayoutIndex] = 
        await contract.getPoolStatus(tierNum);

      // Get additional pool information from database
      const { data: pool, error: poolError } = await supabase
        .from('pools')
        .select(`
          *,
          contributions!inner(
            id,
            user_address,
            batch_number,
            status
          )
        `)
        .eq('tier', tierNum)
        .single();

      if (poolError) {
        throw new AppError(500, 'Failed to fetch pool information');
      }

      // Get pending contributions count
      const { count: pendingCount, error: countError } = await supabase
        .from('contributions')
        .select('*', { count: 'exact', head: true })
        .eq('pool_id', pool.id)
        .eq('status', 'pending');

      if (countError) {
        throw new AppError(500, 'Failed to fetch pending contributions count');
      }

      res.json({
        status: 'success',
        data: {
          tier: tierNum,
          currentBatch: currentBatch.toString(),
          contributorsInBatch: contributorsInBatch.toString(),
          nextPayoutIndex: nextPayoutIndex.toString(),
          pendingContributions: pendingCount || 0,
          lastPayoutBatch: pool.last_payout_batch,
          lastPayoutIndex: pool.last_payout_index,
          contributionAmount: pool.contribution_amount
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

      // Get pool information
      const { data: pool, error: poolError } = await supabase
        .from('pools')
        .select('id, last_payout_batch, last_payout_index')
        .eq('tier', tierNum)
        .single();

      if (poolError || !pool) {
        throw new AppError(500, 'Failed to fetch pool information');
      }

      // Get pending contributions ordered by batch and creation time
      const { data, error } = await supabase
        .from('contributions')
        .select(`
          *,
          user:user_address(
            wallet_address
          )
        `)
        .eq('pool_id', pool.id)
        .eq('status', 'pending')
        .order('batch_number', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        throw new AppError(500, 'Failed to fetch payout queue');
      }

      res.json({
        status: 'success',
        data: {
          queue: data,
          lastPayoutBatch: pool.last_payout_batch,
          lastPayoutIndex: pool.last_payout_index
        }
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

      // Get pool status
      const { data: pool } = await supabase
        .from('pools')
        .select('id, current_batch, payout_index')
        .eq('tier', tierNum)
        .single();

      if (!pool) {
        throw new AppError(500, 'Pool not found');
      }

      // Verify there are pending contributions
      const { count: pendingCount } = await supabase
        .from('contributions')
        .select('*', { count: 'exact', head: true })
        .eq('pool_id', pool.id)
        .eq('status', 'pending');

      if (!pendingCount) {
        throw new AppError(400, 'No pending contributions to process');
      }

      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY!, provider);
      const contract = new ethers.Contract(TWO_PAY_ADDRESS, TWO_PAY_ABI, wallet);

      const tx = await contract.processPayout(tierNum);
      await tx.wait();

      res.json({
        status: 'success',
        data: {
          transactionHash: tx.hash,
          currentBatch: pool.current_batch,
          payoutIndex: pool.payout_index
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