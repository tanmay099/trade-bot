/**
 * Ticker-Based Position Monitor Module
 * Uses WebSocket streaming for real-time position monitoring
 * Replaces polling with efficient tick-based monitoring
 */

import { getTickerManager, TickData, TickerMode } from '../../ticker-manager';
import { recordTradeExit, TradeConfig } from '../trades/persistence';
import { isPaperTradeMode, placeSellOrder } from '../orders/executor';


export interface MonitorConfig {
  marketCloseTime: string;
  timeoutSeconds: number;
  trailingSL?: {
    profitThreshold: number;    // Points of profit to trigger trailing (default: 20)
    newSLDistance: number;      // New SL distance after trailing (default: 10)
  } | undefined;
}

export interface OrderConfig {
  exchange: string;
  product: string;
  validity: string;
  variety: string;
}

interface MonitorState {
  tradingsymbol: string;
  instrumentToken: number;
  entryPrice: number;
  quantity: number;
  currentStopLoss: number;
  initialStopLoss: number;     // Original SL at entry
  target: number;
  initialTarget: number;       // Original target at entry
  isBullTrade: boolean;
  slModified: boolean;
  isActive: boolean;
  startTime: number;
}

/**
 * TickerPositionMonitor - Real-time position monitoring using WebSocket
 */
export class TickerPositionMonitor {
  private kite: any;
  private monitorConfig: MonitorConfig;
  private orderConfig: OrderConfig;
  private tradeConfig: TradeConfig;
  private state: MonitorState;
  private tickerManager = getTickerManager();
  private exitPromiseResolve: (() => void) | null = null;
  private marketCloseTimer: NodeJS.Timeout | null = null;

  constructor(
    kite: any,
    monitorConfig: MonitorConfig,
    orderConfig: OrderConfig,
    tradeConfig: TradeConfig
  ) {
    this.kite = kite;
    this.monitorConfig = monitorConfig;
    this.orderConfig = orderConfig;
    this.tradeConfig = tradeConfig;
    
    this.state = {
      tradingsymbol: '',
      instrumentToken: 0,
      entryPrice: 0,
      quantity: 0,
      currentStopLoss: 0,
      initialStopLoss: 0,
      target: 0,
      initialTarget: 0,
      isBullTrade: true,
      slModified: false,
      isActive: false,
      startTime: 0
    };
  }

  /**
   * Start monitoring a position using WebSocket ticker
   */
  async monitor(
    tradingsymbol: string,
    instrumentToken: number,
    entryPrice: number,
    quantity: number,
    initialStopLoss: number,
    target: number,
    isBullTrade: boolean
  ): Promise<void> {
    // Initialize state
    this.state = {
      tradingsymbol,
      instrumentToken,
      entryPrice,
      quantity,
      currentStopLoss: initialStopLoss,
      initialStopLoss: initialStopLoss,
      target,
      initialTarget: target,
      isBullTrade,
      slModified: false,
      isActive: true,
      startTime: Date.now() / 1000
    };

    const profitThreshold = this.monitorConfig.trailingSL?.profitThreshold ?? 20;
    const newSLDistance = this.monitorConfig.trailingSL?.newSLDistance ?? 10;

    console.info(
      `👁️ [TICKER] Monitoring ${tradingsymbol}\n` +
      `   Token: ${instrumentToken}\n` +
      `   Entry: ₹${entryPrice.toFixed(2)}\n` +
      `   Initial SL: ₹${this.state.currentStopLoss.toFixed(2)}\n` +
      `   Target: ₹${target.toFixed(2)}\n` +
      `   Type: ${isBullTrade ? 'BULL' : 'BEAR'}\n` +
      `   Trailing SL: ${profitThreshold}pts profit → ${newSLDistance}pts SL\n` +
      `   Mode: WebSocket Streaming 🔌`
    );

    // Ensure ticker is connected
    if (!this.tickerManager.isActive()) {
      throw new Error('Ticker not connected. Initialize and connect ticker first.');
    }

    // Setup market close timer
    this.setupMarketCloseTimer();

    // Create a promise that will be resolved when position is exited
    return new Promise<void>((resolve) => {
      this.exitPromiseResolve = resolve;

      // Subscribe to the instrument with full mode for depth data
      this.tickerManager.subscribeBySymbol(
        tradingsymbol,
        instrumentToken,
        'full',
        (tick) => this.onTick(tick)
      );
    });
  }

  /**
   * Handle incoming tick data
   */
  private onTick(tick: TickData): void {
    if (!this.state.isActive) return;

    const ltp = tick.last_price;
    const profitLoss = ltp - this.state.entryPrice;
    const profitThreshold = this.monitorConfig.trailingSL?.profitThreshold ?? 20;
    const newSLDistance = this.monitorConfig.trailingSL?.newSLDistance ?? 10;

    // Log current status (throttled to avoid spam)
    this.logStatus(ltp, profitLoss);

    // Broadcast P/L via WebSocket (throttled - every 500ms)
    this.broadcastPnL(ltp, profitLoss);

    // TRAILING STOP LOSS LOGIC
    if (!this.state.slModified && profitLoss >= profitThreshold) {
    const newStopLoss = this.state.currentStopLoss + newSLDistance;  // ✅ old SL + 10

      console.info(
        `\n🔄 TRAILING STOP LOSS ACTIVATED!\n` +
        `   Profit: ₹${profitLoss.toFixed(2)} >= Threshold: ₹${profitThreshold.toFixed(2)}\n` +
        `   Modifying SL: ₹${this.state.currentStopLoss.toFixed(2)} → ₹${newStopLoss.toFixed(2)}\n` +
        `   Locking in minimum profit: ₹${newSLDistance.toFixed(2)}\n`
      );

      this.state.currentStopLoss = newStopLoss;
      this.state.slModified = true;
    }

    // Check for SL or Target hit
    if (ltp <= this.state.currentStopLoss || ltp >= this.state.target) {
      const exitReason: 'SL' | 'TARGET' = ltp <= this.state.currentStopLoss ? 'SL' : 'TARGET';
      this.executeExit(ltp, exitReason, profitLoss);
    }
  }

  /**
   * Broadcast P/L via WebSocket (throttled)
   */
  private lastBroadcastTime = 0;
  private broadcastPnL(ltp: number, profitLoss: number): void {
    const now = Date.now();
    // Broadcast every 500ms to keep UI responsive
    if (now - this.lastBroadcastTime < 500) return;
    this.lastBroadcastTime = now;

    if (typeof global !== 'undefined' && (global as any).wsBroadcast) {
      const unrealizedPnL = profitLoss * this.state.quantity;
      const unrealizedPnLPercent = (profitLoss / this.state.entryPrice) * 100;

      (global as any).wsBroadcast('pnl', {
        tradingsymbol: this.state.tradingsymbol,
        currentPrice: ltp,
        entryPrice: this.state.entryPrice,
        quantity: this.state.quantity,
        unrealizedPnL,
        unrealizedPnLPercent,
        stopLoss: this.state.currentStopLoss,
        initialStopLoss: this.state.initialStopLoss,
        target: this.state.target,
        initialTarget: this.state.initialTarget,
        distanceToSL: ltp - this.state.currentStopLoss,
        distanceToTarget: this.state.target - ltp,
        slModified: this.state.slModified
      });
    }
  }

  /**
   * Log current status (throttled)
   */
  private lastLogTime = 0;
  private logStatus(ltp: number, profitLoss: number): void {
    const now = Date.now();
    // Log every 5 seconds to avoid spam
    if (now - this.lastLogTime < 5000) return;
    this.lastLogTime = now;

    console.info(
      `📊 [TICK] ${this.state.tradingsymbol} |   ` +
      `LTP: ₹${ltp.toFixed(2)} | ` +
      `P/L: ${profitLoss >= 0 ? '+' : ''}₹${profitLoss.toFixed(2)} | ` +
      `SL: ₹${this.state.currentStopLoss.toFixed(2)} | ` +
      `Target: ₹${this.state.target.toFixed(2)}`
    );
  }

  /**
   * Execute exit and cleanup
   */
  private async executeExit(
    ltp: number,
    exitReason: 'SL' | 'TARGET' | 'EOD',
    profitLoss?: number
  ): Promise<void> {
    if (!this.state.isActive) return;
    this.state.isActive = false;

    const pnl = profitLoss ?? (ltp - this.state.entryPrice);
    const finalPnL = pnl * this.state.quantity;
    const emoji = exitReason === 'SL' ? '🛑' : exitReason === 'TARGET' ? '🎯' : '🔔';

    console.info(
      `\n${emoji} ${exitReason} HIT! Exiting ${this.state.tradingsymbol}\n` +
      `   Entry: ₹${this.state.entryPrice.toFixed(2)}\n` +
      `   Exit: ₹${ltp.toFixed(2)}\n` +
      `   P/L per unit: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}\n` +
      `   Total P/L: ${finalPnL >= 0 ? '+' : ''}₹${finalPnL.toFixed(2)}\n` +
      `   ${this.state.slModified ? '✅ Trailing SL was active' : ''}`
    );

    // Record the exit
    recordTradeExit(ltp, exitReason, this.tradeConfig);

    // Place sell order (respects paper trade mode)
    try {
      await this.placeSellOrderInternal(ltp);
    } catch (e: any) {
      console.error('Error placing exit order:', e?.message ?? e);
    }

    // Cleanup
    this.cleanup();

    // Resolve the monitor promise
    if (this.exitPromiseResolve) {
      this.exitPromiseResolve();
    }
  }

  /**
   * Place sell order (respects paper trade mode)
   */
  private async placeSellOrderInternal(ltp: number): Promise<any> {
    // Use the centralized placeSellOrder from executor which handles paper trade mode
    return placeSellOrder(
      this.kite,
      this.state.tradingsymbol,
      this.state.quantity,
      this.orderConfig
    );
  }

  /**
   * Setup market close timer
   */
  private setupMarketCloseTimer(): void {
    const now = new Date();
    const [hours, minutes] = this.monitorConfig.marketCloseTime.split(':').map(Number);
    
    const closeTime = new Date();
    closeTime.setHours(hours ?? 15, minutes ?? 30, 0, 0);

    const msUntilClose = closeTime.getTime() - now.getTime();

    if (msUntilClose > 0) {
      this.marketCloseTimer = setTimeout(() => {
        if (this.state.isActive) {
          console.info('🔔 Market close reached; exiting position.');
          const ltp = this.tickerManager.getLatestPrice(this.state.instrumentToken);
          this.executeExit(ltp ?? this.state.entryPrice, 'EOD');
        }
      }, msUntilClose);
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    // Clear market close timer
    if (this.marketCloseTimer) {
      clearTimeout(this.marketCloseTimer);
      this.marketCloseTimer = null;
    }

    // Unsubscribe from ticker
    this.tickerManager.unsubscribe([this.state.instrumentToken]);
  }

  /**
   * Manually stop monitoring
   */
  stop(): void {
    if (this.state.isActive) {
      this.state.isActive = false;
      this.cleanup();
      if (this.exitPromiseResolve) {
        this.exitPromiseResolve();
      }
    }
  }

  /**
   * Check if monitoring is active
   */
  isMonitoring(): boolean {
    return this.state.isActive;
  }

  /**
   * Get current state
   */
  getState(): Readonly<MonitorState> {
    return { ...this.state };
  }

  /**
   * Dynamically update SL and/or Target levels
   * Called when user modifies levels via API - affects automatic exit logic
   */
  updateLevels(newStopLoss?: number, newTarget?: number): void {
    if (!this.state.isActive) {
      console.warn('⚠️ Cannot update levels: monitor not active');
      return;
    }

    if (newStopLoss !== undefined) {
      const oldSL = this.state.currentStopLoss;
      this.state.currentStopLoss = newStopLoss;
      console.info(
        `🔄 [MONITOR] Stop Loss updated: ₹${oldSL.toFixed(2)} → ₹${newStopLoss.toFixed(2)}`
      );

      // Broadcast via WebSocket if available
      if (typeof global !== 'undefined' && (global as any).wsBroadcast) {
        (global as any).wsBroadcast('trailing_sl', {
          type: 'MANUAL_UPDATE',
          oldSL,
          newSL: newStopLoss,
          currentPrice: this.tickerManager.getLatestPrice(this.state.instrumentToken),
          source: 'MANUAL'
        });
      }
    }

    if (newTarget !== undefined) {
      const oldTarget = this.state.target;
      this.state.target = newTarget;
      console.info(
        `🔄 [MONITOR] Target updated: ₹${oldTarget.toFixed(2)} → ₹${newTarget.toFixed(2)}`
      );
    }
  }

  /**
   * Get current levels (for API responses)
   */
  getLevels(): { stopLoss: number; target: number; initialStopLoss: number; initialTarget: number } {
    return {
      stopLoss: this.state.currentStopLoss,
      target: this.state.target,
      initialStopLoss: this.state.initialStopLoss,
      initialTarget: this.state.initialTarget
    };
  }
}

/**
 * Factory function for backward compatibility
 * Uses ticker-based monitoring instead of polling
 */
export async function monitorAndExitWithTicker(
  kite: any,
  tradingsymbol: string,
  instrumentToken: number,
  entryPrice: number,
  quantity: number,
  stopLoss: number,
  target: number,
  isBullTrade: boolean,
  monitorConfig: MonitorConfig,
  orderConfig: OrderConfig,
  tradeConfig: TradeConfig
): Promise<void> {
  const monitor = new TickerPositionMonitor(
    kite,
    monitorConfig,
    orderConfig,
    tradeConfig
  );

  return monitor.monitor(
    tradingsymbol,
    instrumentToken,
    entryPrice,
    quantity,
    stopLoss,
    target,
    isBullTrade
  );
}

/**
 * Checks if it's past market close time
 */
export function isMarketClosed(marketCloseTime: string): boolean {
  const nowStr = new Date().toTimeString().slice(0, 5);
  return nowStr >= marketCloseTime;
}

/**
 * Checks if current time is within trading hours
 */
export function isTradingTime(
  marketOpenTime: string,
  marketCloseTime: string
): boolean {
  const nowStr = new Date().toTimeString().slice(0, 5);
  return nowStr >= marketOpenTime && nowStr < marketCloseTime;
}
