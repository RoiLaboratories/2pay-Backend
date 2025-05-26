import { Response } from 'express';
import { ethers } from 'ethers';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';

// Get environment-specific configuration
const getConfig = () => {
    const isTestnet = process.env.NODE_ENV !== 'production';
    return {
        contractAddress: isTestnet 
            ? process.env.TWO_PAY_TESTNET_ADDRESS 
            : process.env.TWO_PAY_MAINNET_ADDRESS,
        usdcAddress: isTestnet
            ? process.env.USDC_TESTNET_ADDRESS
            : process.env.USDC_MAINNET_ADDRESS,
        rpcUrl: isTestnet
            ? process.env.BASE_SEPOLIA_RPC_URL
            : process.env.BASE_MAINNET_RPC_URL,
        network: isTestnet
            ? { chainId: 84532, name: 'base-sepolia' }
            : { chainId: 8453, name: 'base' }
    };
};

// Import contract ABIs
const USDC_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];
import TWO_PAY_ABI from '../abi/TWO_PAY_ABI.json';


export const contributionController = {
    async registerContribution(req: AuthenticatedRequest, res: Response) {
        try {
            const { tier, txHash } = req.body;
            const userAddress = req.user?.address;
            const config = getConfig();

            if (!userAddress) {
                throw new AppError(401, 'User not authenticated');
            }

            if (!config.contractAddress || !ethers.isAddress(config.contractAddress)) {
                logger.error('Contract address is missing or invalid:', config.contractAddress);
                throw new AppError(500, 'Contract configuration error');
            }

            if (!config.usdcAddress || !ethers.isAddress(config.usdcAddress)) {
                logger.error('USDC address is missing or invalid:', config.usdcAddress);
                throw new AppError(500, 'USDC configuration error');
            }

            // Verify transaction on-chain
            const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.network);
            const tx = await provider.getTransaction(txHash);
            
            if (!tx) {
                throw new AppError(400, 'Transaction not found');
            }

            // Verify transaction is to our contract
            if (tx.to?.toLowerCase() !== config.contractAddress.toLowerCase()) {
                throw new AppError(400, 'Invalid transaction destination');
            }

            // Verify USDC transfer
            const receipt = await provider.getTransactionReceipt(txHash);
            if (!receipt) {
                throw new AppError(400, 'Transaction receipt not found');
            }

            const usdcContract = new ethers.Contract(config.usdcAddress, USDC_ABI, provider);
            const transferEvents = await usdcContract.queryFilter(
                usdcContract.filters.Transfer(userAddress, config.contractAddress),
                receipt.blockNumber,
                receipt.blockNumber
            );

            if (transferEvents.length === 0) {
                throw new AppError(400, 'No USDC transfer found in transaction');
            }

            // USDC has 6 decimal places, so amounts are in millionths
            // Tier 1: 10 USDC = 10_000_000
            // Tier 2: 50 USDC = 50_000_000
            // Tier 3: 500 USDC = 500_000_000
            const expectedAmount = tier === 1 ? 10_000_000n : tier === 2 ? 50_000_000n : 500_000_000n;
            const transferAmount = (transferEvents[0] as ethers.EventLog).args[2];
            
            // Debug logging for amounts
            logger.debug('Contribution amounts:', {
                expectedAmount: expectedAmount.toString(),
                receivedAmount: transferAmount.toString(),
                tier,
                transferEvent: JSON.stringify(transferEvents[0], (_, v) => 
                    typeof v === 'bigint' ? v.toString() : v
                )
            });
            
            if (transferAmount.toString() !== expectedAmount.toString()) {
                logger.error('Amount mismatch:', {
                    expected: expectedAmount.toString(),
                    received: transferAmount.toString(),
                    difference: (BigInt(transferAmount.toString()) - expectedAmount).toString()
                });
                throw new AppError(400, 'Transfer amount does not match tier requirement');
            }

            // Get pool information
            const { data: pool, error: poolError } = await supabase
                .from('pools')
                .select('id, current_batch')
                .eq('tier', tier)
                .single();

            if (poolError || !pool) {
                logger.error('Pool fetch error:', poolError);
                throw new AppError(500, 'Failed to fetch pool information');
            }

            // Convert amount to number for database (bigint type)
            const amountNumber = Number(expectedAmount.toString());
            
            logger.debug('Storing contribution:', {
                userAddress: userAddress.toLowerCase(),
                poolId: pool.id,
                batchNumber: pool.current_batch,
                amount: amountNumber,
                txHash,
                network: process.env.NODE_ENV !== 'production' ? 'base-sepolia' : 'base'
            });            // Log the JWT token for debugging
            const token = (req.headers.authorization || '').split(' ')[1];
            logger.debug('JWT token present:', !!token);
              // Get current batch number from contract
            const contract = new ethers.Contract(config.contractAddress, TWO_PAY_ABI, provider);
            const [currentBatch] = await contract.getPoolStatus(tier);

            const insertData = {
                user_address: userAddress.toLowerCase(),
                pool_id: pool.id,
                batch_number: Number(currentBatch),
                amount: amountNumber,
                transaction_hash: txHash,
                status: 'pending',
                network: process.env.NODE_ENV !== 'production' ? 'base-sepolia' : 'base',
                environment: process.env.NODE_ENV !== 'production' ? 'testnet' : 'mainnet'
            };
            
            logger.debug('Attempting database insertion with:', {
                headers: req.headers,
                insertData
            });

            const { data: contributionData, error: contributionError } = await supabase
                .from('contributions')
                .insert(insertData)
                .select()
                .single();

            if (contributionError || !contributionData) {
                logger.error('Database insertion error:', {
                    error: contributionError,
                    insertData: {
                        user_address: userAddress.toLowerCase(),
                        pool_id: pool.id,
                        amount: amountNumber
                    }
                });
                throw new AppError(500, 'Failed to store contribution');
            }

            // Serialize response data
            const responseData = {
                ...contributionData,
                amount: contributionData.amount.toString(), // Convert number to string for JSON
                network: process.env.NODE_ENV !== 'production' ? 'base-sepolia' : 'base'
            };

            res.status(201).json({
                status: 'success',
                data: responseData
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
                .eq('user_address', address.toLowerCase())
                .order('created_at', { ascending: false });

            if (error) {
                logger.error('Error fetching contributions:', error);
                throw new AppError(500, 'Failed to fetch contributions');
            }

            res.json({
                status: 'success',
                data,
                network: process.env.NODE_ENV !== 'production' ? 'base-sepolia' : 'base'
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