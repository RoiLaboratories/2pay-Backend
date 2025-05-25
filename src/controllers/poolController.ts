import { Response } from 'express';
import { ethers } from 'ethers';
import path from 'path';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';
import fs from 'fs';

// Load the appropriate ABI based on environment
const getContractABI = () => {
    const isTestnet = process.env.NODE_ENV !== 'production';
    const contractFileName = isTestnet ? 'TwoPayTestnet.sol/TwoPayTestnet.json' : 'TwoPay.sol/TwoPay.json';
    const contractPath = path.resolve(__dirname, '../../artifacts/contracts/', contractFileName);
    console.log('[DEBUG] Loading contract from:', contractPath);
    
    try {
        const contractJson = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
        console.log('[DEBUG] ABI loaded successfully for', isTestnet ? 'testnet' : 'mainnet');
        return contractJson.abi;
    } catch (error) {
        console.error('[ERROR] Failed to load ABI:', error);
        return null;
    }
};

const TWO_PAY_ABI = getContractABI();

// Create a provider with specific network configuration
const getProvider = async () => {
    // Use different providers for testnet and mainnet
    const isTestnet = process.env.NODE_ENV !== 'production';
    const provider = new ethers.JsonRpcProvider(
        isTestnet ? process.env.BASE_SEPOLIA_RPC_URL : process.env.BASE_MAINNET_RPC_URL,
        isTestnet ? {
            chainId: 84532,
            name: 'base-sepolia'
        } : {
            chainId: 8453,
            name: 'base'
        }
    );
    
    try {
        await provider.getNetwork();
        return provider;
    } catch (error) {
        console.error('[ERROR] Failed to connect to provider:', error);
        throw new Error('Failed to connect to network');
    }
};

export const poolController = {
    async getPoolStatus(req: AuthenticatedRequest, res: Response) {
        try {
            const { tier } = req.params;
            const tierNum = parseInt(tier);

            if (isNaN(tierNum) || tierNum < 1 || tierNum > 3) {
                throw new AppError(400, 'Invalid tier');
            }

            // Debug logging for contract setup
            const isTestnet = process.env.NODE_ENV !== 'production';
            const contractAddress = isTestnet 
                ? process.env.TWO_PAY_TESTNET_ADDRESS 
                : process.env.TWO_PAY_MAINNET_ADDRESS;
            console.log('[DEBUG] Contract setup check:');
            console.log('- Environment:', isTestnet ? 'testnet' : 'mainnet');
            console.log('- Contract Address:', contractAddress);
            console.log('- Is Valid Address:', contractAddress ? ethers.isAddress(contractAddress) : false);
            console.log('- ABI Available:', TWO_PAY_ABI ? 'Yes' : 'No');

            if (!contractAddress || !ethers.isAddress(contractAddress)) {
                throw new AppError(500, 'Contract address is missing or invalid');
            }

            if (!TWO_PAY_ABI) {
                throw new AppError(500, 'Contract ABI is missing or invalid');
            }

            console.log('[DEBUG] Connecting to network...');
            const provider = await getProvider();
            console.log('[DEBUG] Testing provider connection...');
            const network = await provider.getNetwork();
            console.log('[DEBUG] Connected to network:', network.toJSON());

            const contract = new ethers.Contract(contractAddress, TWO_PAY_ABI, provider);
            const [currentBatch, contributorsInBatch, nextPayoutIndex] = await contract.getPoolStatus(tierNum);

            // Get additional pool information from database
            const { data: pool, error: poolError } = await supabase
                .from('pools')
                .select('*')
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

            return res.json({
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
        } catch (error: any) {
            logger.error('Get pool status error:', error);
            if (error instanceof AppError) {
                return res.status(error.statusCode).json({
                    status: 'error',
                    message: error.message
                });
            }
            return res.status(500).json({
                status: 'error',
                message: 'Failed to get pool status'
            });
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
        } catch (error: any) {
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
            const { data: pendingContributions, error: pendingError, count: pendingCount } = await supabase
                .from('contributions')
                .select('*', { count: 'exact' })
                .eq('pool_id', pool.id)
                .eq('status', 'pending')
                .order('created_at', { ascending: true })
                .limit(5);

            if (pendingError) {
                logger.error('Error fetching pending contributions:', pendingError);
                throw new AppError(500, 'Failed to fetch pending contributions');
            }

            if (!pendingCount) {
                throw new AppError(400, 'No pending contributions to process');
            }

            // Setup contract interaction with environment awareness
            const isTestnet = process.env.NODE_ENV !== 'production';
            const contractAddress = isTestnet 
                ? process.env.TWO_PAY_TESTNET_ADDRESS 
                : process.env.TWO_PAY_MAINNET_ADDRESS;

            if (!contractAddress || !ethers.isAddress(contractAddress)) {
                logger.error('Contract address is missing or invalid:', {
                    address: contractAddress,
                    environment: isTestnet ? 'testnet' : 'mainnet'
                });
                throw new AppError(500, 'Contract address is missing or invalid');
            }

            const provider = new ethers.JsonRpcProvider(
                isTestnet ? process.env.BASE_SEPOLIA_RPC_URL : process.env.BASE_MAINNET_RPC_URL,
                isTestnet ? {
                    chainId: 84532,
                    name: 'base-sepolia'
                } : {
                    chainId: 8453,
                    name: 'base'
                }
            );

            // Use appropriate private key for environment
            const privateKey = isTestnet 
                ? process.env.TESTNET_ADMIN_PRIVATE_KEY 
                : process.env.MAINNET_ADMIN_PRIVATE_KEY;

            if (!privateKey) {
                throw new AppError(500, `Admin private key missing for ${isTestnet ? 'testnet' : 'mainnet'}`);
            }

            const wallet = new ethers.Wallet(privateKey, provider);
            const contract = new ethers.Contract(contractAddress, TWO_PAY_ABI, wallet);

            // Record transaction attempt with environment info
            const { data: txRecord, error: txRecordError } = await supabase
                .from('transactions')
                .insert({
                    type: 'payout',
                    status: 'pending',
                    tier: tierNum,
                    initiated_by: req.user?.address,
                    environment: isTestnet ? 'testnet' : 'mainnet'
                })
                .select()
                .single();

            if (txRecordError) {
                logger.error('Failed to record transaction attempt:', txRecordError);
                throw new AppError(500, 'Failed to record transaction');
            }

            logger.info(`Starting payout transaction for tier ${tierNum} on ${isTestnet ? 'testnet' : 'mainnet'}`);
            const tx = await contract.processPayout(tierNum);
            logger.info(`Transaction sent: ${tx.hash}`);

            // Wait for transaction confirmation
            const receipt = await tx.wait();
            logger.info(`Transaction confirmed: ${receipt.hash} on ${isTestnet ? 'testnet' : 'mainnet'}`);

            // Update transaction record
            const { error: updateTxError } = await supabase
                .from('transactions')
                .update({
                    status: 'confirmed',
                    tx_hash: receipt.hash,
                    block_number: receipt.blockNumber,
                    confirmed_at: new Date().toISOString(),
                    network: isTestnet ? 'base-sepolia' : 'base'
                })
                .eq('id', txRecord.id);

            if (updateTxError) {
                logger.error('Failed to update transaction record:', updateTxError);
                // Don't throw here as the transaction was successful
            }

            // Update contribution statuses
            const contributionIds = pendingContributions?.map(c => c.id) || [];
            const { error: updateContribError } = await supabase
                .from('contributions')
                .update({
                    status: 'processed',
                    processed_at: new Date().toISOString(),
                    tx_hash: receipt.hash,
                    network: isTestnet ? 'base-sepolia' : 'base'
                })
                .in('id', contributionIds);

            if (updateContribError) {
                logger.error('Failed to update contribution statuses:', updateContribError);
                // Don't throw here as the transaction was successful
            }

            res.json({
                status: 'success',
                data: {
                    transactionHash: receipt.hash,
                    blockNumber: receipt.blockNumber,
                    currentBatch: pool.current_batch,
                    payoutIndex: pool.payout_index,
                    processedContributions: contributionIds.length,
                    network: isTestnet ? 'base-sepolia' : 'base'
                }
            });
        } catch (error: any) {
            logger.error('Trigger manual payout error:', error);
            
            // Include transaction hash and network in error response if available
            const txHash = error?.transaction?.hash;
            const isTestnet = process.env.NODE_ENV !== 'production';
            
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    status: 'error',
                    message: error.message,
                    network: isTestnet ? 'base-sepolia' : 'base',
                    ...(txHash && { transactionHash: txHash })
                });
            } else {
                const errorMessage = error?.reason || error?.message || 'Failed to trigger manual payout';
                res.status(500).json({
                    status: 'error',
                    message: errorMessage,
                    network: isTestnet ? 'base-sepolia' : 'base',
                    ...(txHash && { transactionHash: txHash })
                });
            }
        }
    }
};