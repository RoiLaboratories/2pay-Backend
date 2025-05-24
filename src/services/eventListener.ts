import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { TwoPay } from '../../typechain-types/contracts/TwoPay';
import { TwoPay__factory } from '../../typechain-types/factories/contracts/TwoPay__factory';

dotenv.config();

const CONTRACT_ADDRESS = process.env.TWO_PAY_CONTRACT_ADDRESS!;
const WS_URL = process.env.BASE_WS_URL!;
const HTTP_URL = process.env.BASE_RPC_URL!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export class EventListener {
  private wsProvider?: ethers.WebSocketProvider;
  private httpProvider: ethers.JsonRpcProvider;
  private provider: ethers.Provider;
  private contract: TwoPay;
  private isListening: boolean = false;

  constructor() {
    this.httpProvider = new ethers.JsonRpcProvider(HTTP_URL);
    this.provider = this.httpProvider; // Default to HTTP
    this.contract = TwoPay__factory.connect(CONTRACT_ADDRESS, this.provider);

    this.initializeProvider();
  }

  private initializeProvider() {
    try {
      this.wsProvider = new ethers.WebSocketProvider(WS_URL);
      this.provider = this.wsProvider;
      this.contract = TwoPay__factory.connect(CONTRACT_ADDRESS, this.provider);
      console.log('Using WebSocket provider');

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
      this.contract = TwoPay__factory.connect(CONTRACT_ADDRESS, this.provider);
      // Optionally, restart listening or handle subscriptions here if needed
    }
  }

  async start() {
    if (this.isListening) return;
    this.isListening = true;

    console.log('Starting event listener...');

    // Listen for ContributionAdded events
    this.contract.on(this.contract.filters.ContributionAdded(), async (contributor, tier, batch) => {
      try {
        console.log(`New contribution: ${contributor} in tier ${tier}, batch ${batch}`);

        const { data: pool } = await supabase
          .from('pools')
          .select('id')
          .eq('tier', tier)
          .single();

        if (!pool) {
          console.error(`Pool not found for tier ${tier}`);
          return;
        }

        const { error } = await supabase
          .from('contributions')
          .insert({
            user_address: contributor,
            pool_id: pool.id,
            batch_number: batch,
            amount: tier === 1n ? 10000000n : tier === 2n ? 50000000n : 500000000n,
            transaction_hash: 'pending',
            status: 'pending'
          });

        if (error) {
          console.error('Error recording contribution:', error);
          return;
        }

        const { error: updateError } = await supabase
          .from('pools')
          .update({
            current_batch: batch,
            updated_at: new Date().toISOString()
          })
          .eq('id', pool.id);

        if (updateError) {
          console.error('Error updating pool batch:', updateError);
        }
      } catch (error) {
        console.error('Error processing ContributionAdded event:', error);
      }
    });

    // Listen for PayoutProcessed events
    this.contract.on(this.contract.filters.PayoutProcessed(), async (contributor, amount, tier, batch) => {
      try {
        console.log(`New payout: ${contributor} received ${amount} from tier ${tier}, batch ${batch}`);

        const { data: pool } = await supabase
          .from('pools')
          .select('id, payout_index')
          .eq('tier', tier)
          .single();

        if (!pool) {
          console.error(`Pool not found for tier ${tier}`);
          return;
        }

        const { error: payoutError } = await supabase
          .from('payouts')
          .insert({
            recipient_address: contributor,
            pool_id: pool.id,
            batch_number: batch,
            amount: amount,
            transaction_hash: 'pending'
          });

        if (payoutError) {
          console.error('Error recording payout:', payoutError);
          return;
        }

        const { error: contributionError } = await supabase
          .from('contributions')
          .update({ status: 'paid' })
          .eq('user_address', contributor)
          .eq('pool_id', pool.id)
          .eq('batch_number', batch);

        if (contributionError) {
          console.error('Error updating contribution status:', contributionError);
          return;
        }

        const { error: poolUpdateError } = await supabase
          .from('pools')
          .update({
            last_payout_batch: batch,
            last_payout_index: pool.payout_index + 1,
            payout_index: pool.payout_index + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', pool.id);

        if (poolUpdateError) {
          console.error('Error updating pool payout tracking:', poolUpdateError);
        }
      } catch (error) {
        console.error('Error processing PayoutProcessed event:', error);
      }
    });

    console.log('Event listener started successfully');
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

    console.log('Event listener stopped');
  }
}
