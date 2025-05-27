import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import { getNetworkConfig } from '../config/network';
import { logger } from '../config/logger';
import TWO_PAY_ABI from '../abi/TWO_PAY_ABI.json';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

interface EventLog extends ethers.Log {
  args?: Array<any>;
  transactionHash: string;
  blockNumber: number;
}

export class EventPollingService {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private lastProcessedBlock: number;
  private networkConfig = getNetworkConfig();
  private isRunning: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL = 15000; // 15 seconds
  private readonly MAX_BLOCKS_PER_POLL = 100; // Limit blocks processed per poll

  constructor() {
    this.provider = new ethers.JsonRpcProvider(
      this.networkConfig.rpcUrl,
      {
        chainId: this.networkConfig.chainId,
        name: this.networkConfig.networkName.toLowerCase().replace(' ', '-')
      }
    );
    
    this.contract = new ethers.Contract(
      this.networkConfig.contractAddress,
      TWO_PAY_ABI,
      this.provider
    );
    
    this.lastProcessedBlock = 0;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    
    try {
      // Get the last processed block from the database
      const { data: blockData } = await supabase
        .from('sync_state')
        .select('last_processed_block')
        .single();

      this.lastProcessedBlock = blockData?.last_processed_block || 
        (await this.provider.getBlockNumber()) - 1000; // Start from 1000 blocks ago if no state

      // Start polling
      await this.poll();
      this.pollingInterval = setInterval(() => {
        this.poll().catch(error => {
          logger.error('Error in polling interval:', error);
        });
      }, this.POLLING_INTERVAL);
      
      logger.info('Event polling service started', { lastProcessedBlock: this.lastProcessedBlock });
    } catch (error) {
      this.isRunning = false;
      logger.error('Failed to start event polling service:', error);
      throw error;
    }
  }

  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    logger.info('Event polling service stopped');
  }

  private async poll(): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      let fromBlock = this.lastProcessedBlock + 1;
      let toBlock = Math.min(currentBlock, fromBlock + this.MAX_BLOCKS_PER_POLL);

      if (fromBlock > toBlock) {
        return; // Nothing to process
      }

      logger.info('Polling for events', { fromBlock, toBlock });

      // Get contribution events
      const contributionFilter = this.contract.filters.ContributionReceived();
      const contributionEvents = await this.contract.queryFilter(
        contributionFilter,
        fromBlock,
        toBlock
      ) as EventLog[];

      // Get payout events
      const payoutFilter = this.contract.filters.PayoutSent();
      const payoutEvents = await this.contract.queryFilter(
        payoutFilter,
        fromBlock,
        toBlock
      ) as EventLog[];

      // Process events
      for (const event of contributionEvents) {
        if (event.args) {
          const [contributor, tier, batch] = event.args;
          await this.processContribution(contributor, tier, batch, event);
        }
      }

      for (const event of payoutEvents) {
        if (event.args) {
          const [recipient, amount, tier, batch] = event.args;
          await this.processPayout(recipient, amount, tier, batch, event);
        }
      }

      // Update last processed block
      this.lastProcessedBlock = toBlock;
      await supabase
        .from('sync_state')
        .upsert({ 
          id: 1, 
          last_processed_block: toBlock,
          last_sync: new Date().toISOString()
        });

    } catch (error) {
      logger.error('Error during event polling:', error);
    }
  }

  private async processContribution(contributor: string, tier: bigint, batch: bigint, event: EventLog): Promise<void> {
    try {
      logger.info('Processing contribution event:', {
        contributor: contributor.toLowerCase(),
        tier: Number(tier),
        batch: Number(batch),
        txHash: event.transactionHash
      });

      // Find and update contribution in database
      const { data: contribution, error: findError } = await supabase
        .from('contributions')
        .select('*')
        .eq('user_address', contributor.toLowerCase())
        .eq('status', 'pending')
        .eq('transaction_hash', event.transactionHash)
        .single();

      if (findError) {
        logger.error('Error finding contribution:', findError);
        return;
      }

      if (!contribution) {
        logger.warn('No matching contribution found:', {
          address: contributor.toLowerCase(),
          txHash: event.transactionHash
        });
        return;
      }

      // Update contribution status
      const { error: updateError } = await supabase
        .from('contributions')
        .update({
          status: 'confirmed',
          batch_number: Number(batch)
        })
        .eq('id', contribution.id);

      if (updateError) {
        logger.error('Failed to update contribution:', updateError);
        return;
      }

      // Update pool batch number
      await supabase
        .from('pools')
        .update({ current_batch: Number(batch) })
        .eq('tier', Number(tier));

      logger.info('Successfully processed contribution:', {
        id: contribution.id,
        status: 'confirmed',
        batchNumber: Number(batch)
      });
    } catch (error) {
      logger.error('Error processing contribution:', error);
    }
  }

  private async processPayout(recipient: string, amount: bigint, tier: bigint, batch: bigint, event: EventLog): Promise<void> {
    try {
      logger.info('Processing payout event:', {
        recipient: recipient.toLowerCase(),
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
        .eq('user_address', recipient.toLowerCase())
        .eq('tier', Number(tier))
        .eq('batch_number', Number(batch));

      if (updateError) {
        logger.error('Failed to update contribution status:', updateError);
        return;
      }

      // Record the payout
      const { error: insertError } = await supabase
        .from('payouts')
        .insert({
          user_address: recipient.toLowerCase(),
          tier: Number(tier),
          batch_number: Number(batch),
          amount: amount.toString(),
          transaction_hash: event.transactionHash,
          block_number: event.blockNumber,
          processed_at: new Date().toISOString()
        });

      if (insertError) {
        logger.error('Failed to record payout:', insertError);
        return;
      }

      logger.info('Successfully processed payout:', {
        recipient: recipient.toLowerCase(),
        tier: Number(tier),
        batch: Number(batch)
      });
    } catch (error) {
      logger.error('Error processing payout:', error);
    }
  }

  public async getLastProcessedBlock(): Promise<number> {
    return this.lastProcessedBlock;
  }
}
