import { Response } from 'express';
import { ethers } from 'ethers';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';

const TWO_PAY_ADDRESS = process.env.TWO_PAY_CONTRACT_ADDRESS!;
const USDC_ADDRESS = process.env.USDC_ADDRESS!;

// USDC ABI for transfer event
const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

export const contributionController = {
  async registerContribution(req: AuthenticatedRequest, res: Response) {
    try {
      const { tier, txHash } = req.body;
      const userAddress = req.user?.address;

      if (!userAddress) {
        throw new AppError(401, 'User not authenticated');
      }

      // Verify transaction on-chain
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const tx = await provider.getTransaction(txHash);
      
      if (!tx) {
        throw new AppError(400, 'Transaction not found');
      }

      // Verify transaction is to our contract
      if (tx.to?.toLowerCase() !== TWO_PAY_ADDRESS.toLowerCase()) {
        throw new AppError(400, 'Invalid transaction destination');
      }

      // Verify USDC transfer
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        throw new AppError(400, 'Transaction receipt not found');
      }

      const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
      const transferEvents = await usdcContract.queryFilter(
        usdcContract.filters.Transfer(userAddress, TWO_PAY_ADDRESS),
        receipt.blockNumber,
        receipt.blockNumber
      );

      if (transferEvents.length === 0) {
        throw new AppError(400, 'No USDC transfer found in transaction');
      }

      // Verify transfer amount matches tier
      const expectedAmount = tier === 1 ? 10000000n : tier === 2 ? 50000000n : 500000000n;
      const transferAmount = (transferEvents[0] as ethers.EventLog).args[2];
      if (transferAmount !== expectedAmount) {
        throw new AppError(400, 'Transfer amount does not match tier requirement');
      }

      // Get pool information
      const { data: pool, error: poolError } = await supabase
        .from('pools')
        .select('id, current_batch')
        .eq('tier', tier)
        .single();

      if (poolError || !pool) {
        throw new AppError(500, 'Failed to fetch pool information');
      }

      // Store contribution in Supabase
      const { data, error } = await supabase
        .from('contributions')
        .insert({
          user_address: userAddress,
          pool_id: pool.id,
          batch_number: pool.current_batch,
          amount: expectedAmount,
          transaction_hash: txHash,
          status: 'pending'
        })
        .select()
        .single();

      if (error) {
        throw new AppError(500, 'Failed to store contribution');
      }

      res.status(201).json({
        status: 'success',
        data
      });
    } catch (error) {
      logger.error('Contribution registration error:', error);
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          status: 'error',
          message: error.message
        });
      } else {
        res.status(500).json({
          status: 'error',
          message: 'Failed to register contribution'
        });
      }
    }
  },

  async getUserContributions(req: AuthenticatedRequest, res: Response) {
    try {
      const { address } = req.params;
      const userAddress = req.user?.address;

      if (!userAddress || userAddress.toLowerCase() !== address.toLowerCase()) {
        throw new AppError(403, 'Unauthorized to view these contributions');
      }

      const { data, error } = await supabase
        .from('contributions')
        .select(`
          *,
          pools:tier,
          payouts!inner(
            amount,
            batch_number,
            created_at
          )
        `)
        .eq('user_address', address)
        .order('created_at', { ascending: false });

      if (error) {
        throw new AppError(500, 'Failed to fetch contributions');
      }

      res.json({
        status: 'success',
        data
      });
    } catch (error) {
      logger.error('Get user contributions error:', error);
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          status: 'error',
          message: error.message
        });
      } else {
        res.status(500).json({
          status: 'error',
          message: 'Failed to fetch contributions'
        });
      }
    }
  }
}; 