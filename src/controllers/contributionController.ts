import { Response } from 'express';
import { ethers } from 'ethers';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';

const TWO_PAY_ADDRESS = process.env.TWO_PAY_CONTRACT_ADDRESS!;
const USDC_ADDRESS = process.env.USDC_ADDRESS!;

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

      // Store contribution in Supabase
      const { data, error } = await supabase
        .from('contributions')
        .insert({
          user_address: userAddress,
          tier,
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
        .select('*')
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