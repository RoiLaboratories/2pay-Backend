import { Response } from 'express';
import { ethers } from 'ethers';
import path from 'path';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../app';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';
import fs from 'fs';
import { getNetworkConfig } from '../config/network';

// Load the contract ABI from the dedicated ABI file
const getContractABI = () => {
    try {
        const abiPath = path.resolve(__dirname, '../abi/TWO_PAY_ABI.json');
        console.log('[DEBUG] Loading ABI from:', abiPath);
        
        if (!fs.existsSync(abiPath)) {
            console.error('[ERROR] ABI file not found at:', abiPath);
            return null;
        }

        const contractAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        console.log('[DEBUG] ABI loaded successfully');
        return contractAbi;
    } catch (error) {
        console.error('[ERROR] Failed to load ABI:', error);
        return null;
    }
};

const TWO_PAY_ABI = getContractABI();

// Create a provider with network configuration
const getProvider = async () => {
    const networkConfig = getNetworkConfig();
    logger.info('Initializing provider with config:', {
        rpcUrl: networkConfig.rpcUrl,
        chainId: networkConfig.chainId,
        networkName: networkConfig.networkName
    });

    const provider = new ethers.JsonRpcProvider(
        networkConfig.rpcUrl,
        {
            chainId: networkConfig.chainId,
            name: networkConfig.networkName.toLowerCase().replace(' ', '-')
        }
    );
    
    try {
        const network = await provider.getNetwork();
        logger.info('Successfully connected to network:', {
            chainId: network.chainId,
            name: network.name
        });
        return provider;
    } catch (error) {
        logger.error('Failed to connect to provider:', {
            error: error.message,
            code: error.code,
            rpcUrl: networkConfig.rpcUrl,
            chainId: networkConfig.chainId
        });
        throw new AppError(500, `Failed to connect to network: ${error.message}`);
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
            const networkConfig = getNetworkConfig();
            const contractAddress = networkConfig.contractAddress;
            
            logger.info('Contract setup check:', {
                environment: networkConfig.networkName,
                contractAddress,
                isValidAddress: contractAddress ? ethers.isAddress(contractAddress) : false,
                abiAvailable: TWO_PAY_ABI ? true : false,
                rpcUrl: networkConfig.rpcUrl
            });

            if (!contractAddress || !ethers.isAddress(contractAddress)) {
                throw new AppError(500, `Contract address is missing or invalid: ${contractAddress}`);
            }

            if (!TWO_PAY_ABI) {
                throw new AppError(500, 'Contract ABI could not be loaded. Check the ABI file.');
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
            const networkConfig = getNetworkConfig();
            const contractAddress = networkConfig.contractAddress;

            if (!contractAddress || !ethers.isAddress(contractAddress)) {
                logger.error('Contract address is missing or invalid:', {
                    address: contractAddress,
                    environment: networkConfig.networkName
                });
                throw new AppError(500, 'Contract address is missing or invalid');
            }

            const provider = new ethers.JsonRpcProvider(
                networkConfig.rpcUrl,
                {
                    chainId: networkConfig.chainId,
                    name: networkConfig.networkName.toLowerCase().replace(' ', '-')
                }
            );

            // Use appropriate private key for environment
            const privateKey = networkConfig.adminPrivateKey;

            if (!privateKey) {
                throw new AppError(500, `Admin private key missing for ${networkConfig.networkName}`);
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
                    environment: networkConfig.networkName
                })
                .select()
                .single();

            if (txRecordError) {
                logger.error('Failed to record transaction attempt:', txRecordError);
                throw new AppError(500, 'Failed to record transaction');
            }

            logger.info(`Starting payout transaction for tier ${tierNum} on ${networkConfig.networkName}`);
            const tx = await contract.processPayout(tierNum);
            logger.info(`Transaction sent: ${tx.hash}`);

            // Wait for transaction confirmation
            const receipt = await tx.wait();
            logger.info(`Transaction confirmed: ${receipt.hash} on ${networkConfig.networkName}`);

            // Update transaction record
            const { error: updateTxError } = await supabase
                .from('transactions')
                .update({
                    status: 'confirmed',
                    tx_hash: receipt.hash,
                    block_number: receipt.blockNumber,
                    confirmed_at: new Date().toISOString(),
                    network: networkConfig.networkName.toLowerCase().replace(' ', '-')
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
                    network: networkConfig.networkName.toLowerCase().replace(' ', '-')
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
                    network: networkConfig.networkName.toLowerCase().replace(' ', '-')
                }
            });
        } catch (error: any) {
            logger.error('Trigger manual payout error:', error);
            
            // Include transaction hash and network in error response if available
            const txHash = error?.transaction?.hash;
            const networkConfig = getNetworkConfig();
            
            if (error instanceof AppError) {
                res.status(error.statusCode).json({
                    status: 'error',
                    message: error.message,
                    network: networkConfig.networkName.toLowerCase().replace(' ', '-'),
                    ...(txHash && { transactionHash: txHash })
                });
            } else {
                const errorMessage = error?.reason || error?.message || 'Failed to trigger manual payout';
                res.status(500).json({
                    status: 'error',
                    message: errorMessage,
                    network: networkConfig.networkName.toLowerCase().replace(' ', '-'),
                    ...(txHash && { transactionHash: txHash })
                });
            }
        }
    }
};