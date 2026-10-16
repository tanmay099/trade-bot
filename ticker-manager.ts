/**
 * Ticker Manager Module
 * Handles Kite WebSocket connection for real-time price streaming
 * Replaces polling mechanism with efficient WebSocket-based monitoring
 */

import { EventEmitter } from 'events';
import { KiteTicker } from 'kiteconnect';

export interface TickData {
  instrument_token: number;
  tradable: boolean;
  mode: string;
  last_price: number;
  last_traded_quantity?: number;
  average_traded_price?: number;
  volume_traded?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  ohlc?: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  change?: number;
  last_trade_time?: Date | null;
  exchange_timestamp?: Date | null;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  depth?: {
    buy: Array<{ quantity: number; price: number; orders: number }>;
    sell: Array<{ quantity: number; price: number; orders: number }>;
  };
}

export interface TickerConfig {
  apiKey: string;
  accessToken: string;
  reconnect?: boolean;
  maxRetry?: number;
  maxDelay?: number;
}

export type TickerMode = 'ltp' | 'quote' | 'full';

interface InstrumentSubscription {
  token: number;
  mode: TickerMode;
  symbol?: string;
  callbacks: Set<(tick: TickData) => void>;
}

/**
 * TickerManager - Singleton class for managing Kite WebSocket connections
 * Provides centralized price streaming with callback-based updates
 */
export class TickerManager extends EventEmitter {
  private static instance: TickerManager | null = null;
  
  private ticker: InstanceType<typeof KiteTicker> | null = null;
  private config: TickerConfig | null = null;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  
  // Subscriptions map: token -> subscription details
  private subscriptions: Map<number, InstrumentSubscription> = new Map();
  
  // Latest tick data cache
  private tickCache: Map<number, TickData> = new Map();
  
  // Symbol to token mapping for easy lookup
  private symbolToToken: Map<string, number> = new Map();
  
  // Reconnection state
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 50;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): TickerManager {
    if (!TickerManager.instance) {
      TickerManager.instance = new TickerManager();
    }
    return TickerManager.instance;
  }

  /**
   * Initialize the ticker with Kite credentials
   */
  initialize(config: TickerConfig): void {
    if (this.ticker && this.isConnected) {
      console.warn('⚠️ Ticker already initialized and connected');
      return;
    }

    this.config = config;
    this.maxReconnectAttempts = config.maxRetry ?? 50;

    this.ticker = new KiteTicker({
      api_key: config.apiKey,
      access_token: config.accessToken,
      reconnect: config.reconnect ?? true,
      max_retry: config.maxRetry ?? 50,
      max_delay: config.maxDelay ?? 60
    });

    this.setupEventHandlers();
    console.info('✅ TickerManager initialized');
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ticker) return;

    // Connection established
    this.ticker.on('connect', () => {
      console.info('🔌 WebSocket connected');
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      
      // Re-subscribe to all instruments after reconnection
      this.resubscribeAll();
      
      this.emit('connect');
    });

    // Tick data received
    this.ticker.on('ticks', (ticks: TickData[]) => {
      this.processTicks(ticks);
    });

    // Disconnection
    this.ticker.on('disconnect', (error: Error) => {
      console.warn('⚠️ WebSocket disconnected:', error?.message ?? 'Unknown reason');
      this.isConnected = false;
      this.emit('disconnect', error);
    });

    // Error
    this.ticker.on('error', (error: Error) => {
      console.error('❌ WebSocket error:', error?.message ?? error);
      this.emit('error', error);
    });

    // Close
    this.ticker.on('close', (reason: string) => {
      console.info('🔒 WebSocket closed:', reason);
      this.isConnected = false;
      this.emit('close', reason);
    });

    // Reconnection attempt
    this.ticker.on('reconnect', (attempt: number, interval: number) => {
      console.info(`🔄 Reconnecting... Attempt ${attempt}, next in ${interval}s`);
      this.reconnectAttempts = attempt;
      this.emit('reconnect', attempt, interval);
    });

    // No more reconnection attempts
    this.ticker.on('noreconnect', () => {
      console.error('❌ Max reconnection attempts reached');
      this.emit('noreconnect');
    });

    // Order updates (if subscribed)
    this.ticker.on('order_update', (order: any) => {
      console.info('📋 Order update:', order);
      this.emit('order_update', order);
    });
  }

  /**
   * Connect to WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ticker) {
        reject(new Error('Ticker not initialized. Call initialize() first.'));
        return;
      }

      if (this.isConnected) {
        resolve();
        return;
      }

      if (this.isConnecting) {
        // Wait for existing connection attempt
        this.once('connect', () => resolve());
        this.once('error', (err) => reject(err));
        return;
      }

      this.isConnecting = true;

      const connectTimeout = setTimeout(() => {
        this.isConnecting = false;
        reject(new Error('Connection timeout'));
      }, 30000);

      this.once('connect', () => {
        clearTimeout(connectTimeout);
        resolve();
      });

      this.once('error', (err) => {
        clearTimeout(connectTimeout);
        this.isConnecting = false;
        reject(err);
      });

      this.ticker.connect();
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ticker && this.isConnected) {
      this.ticker.disconnect();
      this.isConnected = false;
      this.subscriptions.clear();
      this.tickCache.clear();
      this.symbolToToken.clear();
      console.info('🔌 Ticker disconnected');
    }
  }

  /**
   * Subscribe to instruments for price updates
   * @param tokens - Array of instrument tokens
   * @param mode - Subscription mode: 'ltp', 'quote', or 'full'
   * @param callback - Optional callback for tick updates
   */
  subscribe(
    tokens: number[],
    mode: TickerMode = 'ltp',
    callback?: (tick: TickData) => void
  ): void {
    if (!this.ticker) {
      console.warn('⚠️ Ticker not initialized');
      return;
    }

    const newTokens: number[] = [];

    for (const token of tokens) {
      let subscription = this.subscriptions.get(token);
      
      if (!subscription) {
        subscription = {
          token,
          mode,
          callbacks: new Set()
        };
        this.subscriptions.set(token, subscription);
        newTokens.push(token);
      }

      // Add callback if provided
      if (callback) {
        subscription.callbacks.add(callback);
      }

      // Update mode if higher fidelity requested
      const modeOrder: TickerMode[] = ['ltp', 'quote', 'full'];
      if (modeOrder.indexOf(mode) > modeOrder.indexOf(subscription.mode)) {
        subscription.mode = mode;
      }
    }

    // Subscribe to new tokens
    if (this.isConnected && newTokens.length > 0) {
      this.ticker.subscribe(newTokens);
      this.ticker.setMode(mode, newTokens);
      console.info(`📊 Subscribed to ${newTokens.length} instruments in ${mode} mode`);
    }
  }

  /**
   * Subscribe using trading symbol (requires instruments lookup)
   */
  subscribeBySymbol(
    symbol: string,
    token: number,
    mode: TickerMode = 'ltp',
    callback?: (tick: TickData) => void
  ): void {
    this.symbolToToken.set(symbol, token);
    
    const subscription = this.subscriptions.get(token);
    if (subscription) {
      subscription.symbol = symbol;
    }
    
    this.subscribe([token], mode, callback);
  }

  /**
   * Unsubscribe from instruments
   */
  unsubscribe(tokens: number[], callback?: (tick: TickData) => void): void {
    if (!this.ticker) return;

    const tokensToRemove: number[] = [];

    for (const token of tokens) {
      const subscription = this.subscriptions.get(token);
      if (!subscription) continue;

      if (callback) {
        subscription.callbacks.delete(callback);
      } else {
        subscription.callbacks.clear();
      }

      // If no more callbacks, remove subscription
      if (subscription.callbacks.size === 0) {
        this.subscriptions.delete(token);
        this.tickCache.delete(token);
        tokensToRemove.push(token);
        
        // Remove symbol mapping if exists
        if (subscription.symbol) {
          this.symbolToToken.delete(subscription.symbol);
        }
      }
    }

    if (this.isConnected && tokensToRemove.length > 0) {
      this.ticker.unsubscribe(tokensToRemove);
      console.info(`📊 Unsubscribed from ${tokensToRemove.length} instruments`);
    }
  }

  /**
   * Re-subscribe to all instruments after reconnection
   */
  private resubscribeAll(): void {
    if (!this.ticker || this.subscriptions.size === 0) return;

    // Group by mode for efficient subscription
    const byMode: Map<TickerMode, number[]> = new Map();

    for (const [token, subscription] of this.subscriptions) {
      const tokens = byMode.get(subscription.mode) || [];
      tokens.push(token);
      byMode.set(subscription.mode, tokens);
    }

    for (const [mode, tokens] of byMode) {
      this.ticker.subscribe(tokens);
      this.ticker.setMode(mode, tokens);
    }

    console.info(`🔄 Re-subscribed to ${this.subscriptions.size} instruments`);
  }

  /**
   * Process incoming tick data
   */
  private processTicks(ticks: TickData[]): void {
    for (const tick of ticks) {
      const token = tick.instrument_token;
      
      // Update cache
      this.tickCache.set(token, tick);

      // Get subscription and call registered callbacks
      const subscription = this.subscriptions.get(token);
      if (subscription) {
        for (const callback of subscription.callbacks) {
          try {
            callback(tick);
          } catch (e: any) {
            console.error('Error in tick callback:', e?.message ?? e);
          }
        }
      }

      // Emit tick event
      this.emit('tick', tick);
    }

    // Emit batch event
    this.emit('ticks', ticks);
  }

  /**
   * Get latest cached tick for an instrument
   */
  getLatestTick(token: number): TickData | null {
    return this.tickCache.get(token) ?? null;
  }

  /**
   * Get latest price for an instrument
   */
  getLatestPrice(token: number): number | null {
    const tick = this.tickCache.get(token);
    return tick?.last_price ?? null;
  }

  /**
   * Get latest price by trading symbol
   */
  getLatestPriceBySymbol(symbol: string): number | null {
    const token = this.symbolToToken.get(symbol);
    if (!token) return null;
    return this.getLatestPrice(token);
  }

  /**
   * Wait for a price update (with timeout)
   */
  waitForPrice(token: number, timeoutMs: number = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
      // Check cache first
      const cachedPrice = this.getLatestPrice(token);
      if (cachedPrice !== null) {
        resolve(cachedPrice);
        return;
      }

      const timeout = setTimeout(() => {
        this.removeListener('tick', tickHandler);
        reject(new Error(`Timeout waiting for price of token ${token}`));
      }, timeoutMs);

      const tickHandler = (tick: TickData) => {
        if (tick.instrument_token === token) {
          clearTimeout(timeout);
          this.removeListener('tick', tickHandler);
          resolve(tick.last_price);
        }
      };

      this.on('tick', tickHandler);
    });
  }

  /**
   * Check if connected
   */
  isActive(): boolean {
    return this.isConnected;
  }

  /**
   * Get subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get all subscribed tokens
   */
  getSubscribedTokens(): number[] {
    return Array.from(this.subscriptions.keys());
  }
}

// Export singleton instance getter
export function getTickerManager(): TickerManager {
  return TickerManager.getInstance();
}
