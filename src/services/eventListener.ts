import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TwoPayTestnet } from '../../typechain-types/contracts/TwoPayTestnet.sol/TwoPayTestnet';
import { TwoPay } from '../../typechain-types/contracts/TwoPay';
import { TwoPayTestnet__factory } from '../../typechain-types/factories/contracts/TwoPayTestnet.sol/TwoPayTestnet__factory';
import { TwoPay__factory } from '../../typechain-types/factories/contracts/TwoPay__factory';

dotenv.config();

// Get environment-specific configuration
const getConfig = () => {
    const isTestnet = process.env.NODE_ENV !== 'production';
    return {
        contractAddress: isTestnet 
            ? process.env.TWO_PAY_TESTNET_ADDRESS 
            : process.env.TWO_PAY_MAINNET_ADDRESS,
        wsUrl: isTestnet
            ? process.env.BASE_SEPOLIA_WS_URL
            : process.env.BASE_WS_URL,
        httpUrl: isTestnet
            ? process.env.BASE_SEPOLIA_RPC_URL
            : process.env.BASE_MAINNET_RPC_URL,
        network: isTestnet
            ? { chainId: 84532, name: 'base-sepolia' }
            : { chainId: 8453, name: 'base' }
    };
};

const config = getConfig();
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export class EventListener {
    private wsProvider?: ethers.WebSocketProvider;
    private httpProvider: ethers.JsonRpcProvider;
    private provider: ethers.Provider;
    private contract: TwoPayTestnet | TwoPay;
    private isListening: boolean = false;
    private readonly isTestnet: boolean;

    constructor() {
        this.isTestnet = process.env.NODE_ENV !== 'production';
        
        // Initialize HTTP provider with network config
        this.httpProvider = new ethers.JsonRpcProvider(config.httpUrl, config.network);
        this.provider = this.httpProvider; // Default to HTTP

        // Connect to appropriate contract version
        if (this.isTestnet) {
            this.contract = TwoPayTestnet__factory.connect(config.contractAddress!, this.provider);
        } else {
            this.contract = TwoPay__factory.connect(config.contractAddress!, this.provider);
        }

        this.initializeProvider();
    }

    private initializeProvider() {
        try {
            if (!config.wsUrl) {
                console.warn('WebSocket URL not configured, using HTTP only');
                return;
            }

            this.wsProvider = new ethers.WebSocketProvider(config.wsUrl, config.network);
            this.provider = this.wsProvider;
            
            // Reconnect contract with new provider
            if (this.isTestnet) {
                this.contract = TwoPayTestnet__factory.connect(config.contractAddress!, this.provider);
            } else {
                this.contract = TwoPay__factory.connect(config.contractAddress!, this.provider);
            }
            
            console.log('Using WebSocket provider on', this.isTestnet ? 'testnet' : 'mainnet');

            const rawWs = (this.wsProvider as any).websocket;

            if (rawWs) {
                rawWs.on('close', (code: number) => {
                    console.warn(`WebSocket closed with code ${code}. Falling back to HTTP.`);
                    this.handleWsFailure();
                });

                rawWs.on('error', (err: any) => {
                    console.error('WebSocket error:', err);
                    this.handleWsFailure();
                });
            } else {
                console.warn('Raw websocket not available to attach close/error handlers');
            }
        } catch (error) {
            console.warn('Failed to initialize WebSocket. Falling back to HTTP:', error);
            this.fallbackToHttp();
        }
    }

    private handleWsFailure() {
        if (this.wsProvider) {
            try {
                this.wsProvider.destroy();
            } catch {}
            this.wsProvider = undefined;
        }
        this.fallbackToHttp();
    }

    private fallbackToHttp() {
        if (this.provider !== this.httpProvider) {
            console.log('Switching to HTTP provider');
            this.provider = this.httpProvider;
            
            // Reconnect contract with HTTP provider
            if (this.isTestnet) {
                this.contract = TwoPayTestnet__factory.connect(config.contractAddress!, this.provider);
            } else {
                this.contract = TwoPay__factory.connect(config.contractAddress!, this.provider);
            }
        }
    }

    public async start() {
        if (this.isListening) return;

        try {
            // Debug contract setup
            console.log('Starting event listener with config:', {
                contractAddress: config.contractAddress,
                network: config.network,
                providerType: this.wsProvider ? 'WebSocket' : 'HTTP'
            });

            // Test contract connection
            try {
                const owner = await this.contract.owner();
                console.log('Contract connection successful, owner:', owner);
            } catch (error) {
                console.error('Failed to connect to contract:', error);
                throw error;
            }

            // Listen for ContributionAdded events with backtrack
            console.log('Setting up ContributionAdded event listener');

            // Function to process contribution event
            const processContribution = async (contributor: string, tier: bigint, batch: bigint, event: any) => {
                console.log('Received ContributionAdded event:', {
                    contributor: contributor.toLowerCase(),
                    tier: Number(tier),
                    batch: Number(batch),
                    blockNumber: event.blockNumber,
                    txHash: event.transactionHash
                });

                // Update contribution in database
                const { data: contribution, error: findError } = await supabase
                    .from('contributions')
                    .select('*')
                    .eq('user_address', contributor.toLowerCase())
                    .eq('status', 'pending')
                    .eq('transaction_hash', event.transactionHash)  // Match by transaction hash
                    .single();

                if (findError) {
                    console.error('Error finding contribution:', findError);
                    return;
                }

                if (!contribution) {
                    console.error('No matching contribution found:', {
                        address: contributor.toLowerCase(),
                        txHash: event.transactionHash
                    });
                    return;
                }

                console.log('Found matching contribution:', contribution);

                // Update contribution status and batch
                const { error: updateError } = await supabase
                    .from('contributions')
                    .update({
                        status: 'confirmed',
                        batch_number: Number(batch)
                    })
                    .eq('id', contribution.id);

                if (updateError) {
                    console.error('Failed to update contribution:', updateError);
                    return;
                }

                console.log('Successfully updated contribution:', {
                    id: contribution.id,
                    newStatus: 'confirmed',
                    batchNumber: Number(batch)
                });

                // Update pool batch number
                const { error: poolError } = await supabase
                    .from('pools')
                    .update({ current_batch: Number(batch) })
                    .eq('tier', Number(tier));

                if (poolError) {
                    console.error('Failed to update pool:', poolError);
                }
            };

            // Set up event listener using the correct event name and signature
            this.contract.on(
                this.contract.filters.ContributionAdded(),
                async (contributor: string, tier: bigint, batch: bigint, event: any) => {
                    try {
                        await processContribution(contributor, tier, batch, event);
                    } catch (error) {
                        console.error('Error processing contribution event:', error);
                    }
                }
            );

            // Process PayoutProcessed events
            const processPayoutEvent = async (
                contributor: string,
                amount: bigint,
                tier: bigint,
                batch: bigint,
                event: any
            ) => {
                console.log('Processing payout event:', {
                    contributor: contributor.toLowerCase(),
                    amount: amount.toString(),
                    tier: Number(tier),
                    batch: Number(batch),
                    txHash: event.transactionHash
                });

                // Update contribution status to 'paid'
                const { error: updateError } = await supabase
                    .from('contributions')
                    .update({
                        status: 'paid',
                        paid_at: new Date().toISOString(),
                        payout_tx_hash: event.transactionHash
                    })
                    .eq('user_address', contributor.toLowerCase())
                    .eq('tier', Number(tier))
                    .eq('batch_number', Number(batch));

                if (updateError) {
                    console.error('Failed to update contribution status:', updateError);
                    return;
                }

                // Record the payout
                const { error: payoutError } = await supabase
                    .from('payouts')
                    .insert({
                        user_address: contributor.toLowerCase(),
                        tier: Number(tier),
                        batch_number: Number(batch),
                        amount: Number(amount),
                        transaction_hash: event.transactionHash,
                        block_number: event.blockNumber,
                        processed_at: new Date().toISOString()
                    });

                if (payoutError) {
                    console.error('Failed to record payout:', payoutError);
                    return;
                }

                console.log('Successfully processed payout for:', {
                    contributor: contributor.toLowerCase(),
                    tier: Number(tier),
                    batch: Number(batch)
                });
            };

            this.contract.on(
                this.contract.filters.PayoutProcessed(),
                async (contributor: string, amount: bigint, tier: bigint, batch: bigint, event: any) => {
                    try {
                        await processPayoutEvent(contributor, amount, tier, batch, event);
                    } catch (error) {
                        console.error('Error processing payout event:', error);
                    }
                }
            );

            // Keep track of listener status
            this.isListening = true;
            console.log('Event listener started successfully');
        } catch (error) {
            console.error('Failed to start event listener:', error);
            throw error;
        }
    }

    stop() {
        if (!this.isListening) return;
        this.isListening = false;
        this.contract.removeAllListeners();

        if (this.wsProvider) {
            try {
                this.wsProvider.destroy();
            } catch {}
            this.wsProvider = undefined;
        }

        console.log(`Event listener stopped on ${this.isTestnet ? 'testnet' : 'mainnet'}`);
    }
}
