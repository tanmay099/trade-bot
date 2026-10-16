/**
 * Ticker-Based Trading Engine
 * Uses WebSocket streaming for real-time instrument monitoring
 * Replaces polling with efficient tick-based trading logic
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import {
  loadInstruments,
  ensureFreshInstruments,
  findIndexRow,
  findOptionInstrument,
  nearestWeeklyExpiry,
  roundStrike,
  Instrument
} from './modules/instruments/parser';
import {
  loadBoxFromFile,
  computeBoxForToday,
  BoxData,
  BoxConfig
} from './modules/box/calculator';
import {
  detectSignal,
  validateReEntry,
  validateFreshBreakout,
  parseCandles,
  getRecentCandles,
  SignalType,
  SignalConfig,
  Candle
} from './modules/signals/detector';
import {
  loadCurrentTrade,
  getTodayClosedTrades,
  recordTradeEntry,
  TradeConfig,
  TradeReason
} from './modules/trades/persistence';
import {
  getSpotLTP,
  getOptionLTP,
  placeBuyOrder,
  calculateStrikeAndType,
  calculateLevels,
  OrderConfig,
  isPaperTradeMode
} from './modules/orders/executor';
import {
  getTickerManager,
  TickerManager,
  TickData,
  TickerConfig
} from './ticker-manager';
import {
  TickerPositionMonitor,
  MonitorConfig,
  isMarketClosed
} from './modules/monitor/ticker-position-monitor';

export interface TradingConfig {
  // Instrument settings
  instrumentsFile: string;
  indexSymbol: string;
  
  // Box settings
  boxStart: string;
  boxEnd: string;
  boxJsonFile: string;
  boxBreakMargin: number;
  
  // Trading settings
  interval: string;
  lotMultiplier: number;
  roundStrikeTo: number;
  
  // Risk management
  slBuffer: number;
  targetMin: number;
  trailingStopLoss?: {
    profitThreshold: number;
    newSLDistance: number;
  };
  
  // Timing
  checkEverySeconds: number;
  marketCloseTime: string;
  
  // Files
  tradesFile: string;
  currentTradeFile: string;
  
  // Order settings
  exchange: string;
  product: string;
  validity: string;
  variety: string;
  
  // Ticker settings
  apiKey: string;
  accessToken: string;
}

interface TickerEngineState {
  indexToken: number;
  indexSymbol: string;
  currentPrice: number;
  currentCandle: {
    open: number;
    high: number;
    low: number;
    close: number;
    startTime: Date;
  } | null;
  lastCandleProcessed: string | null;
}

/**
 * Ticker-Based Trading Engine
 * Uses WebSocket for real-time price monitoring and trade execution
 */
export class TickerTradingEngine extends EventEmitter {
  private kite: any;
  private config: TradingConfig;
  private instruments: Instrument[];
  private tickerManager: TickerManager;
  private boxData: BoxData | null = null;
  private lastTradeDate: string | null = null;
  private lastTradeCandleTime: string | null = null;
  private activeMonitor: TickerPositionMonitor | null = null;
  private isRunning: boolean = false;
  
  private state: TickerEngineState = {
    indexToken: 0,
    indexSymbol: '',
    currentPrice: 0,
    currentCandle: null,
    lastCandleProcessed: null
  };

  // Candle aggregation
  private candleHistory: Candle[] = [];
  private candleIntervalMs: number = 0;
  private candleTimer: NodeJS.Timeout | null = null;
  private historicalCandlesLoaded: boolean = false;
  private processedCandleTimes: Set<string> = new Set();
  constructor(kite: any, config: TradingConfig) {
    super();
    this.kite = kite;
    this.config = config;
    this.instruments = [];
    this.tickerManager = getTickerManager();
    
    // Parse candle interval
    this.candleIntervalMs = this.parseIntervalToMs(config.interval);
  }

  /**
   * Parse interval string to milliseconds
   */
  private parseIntervalToMs(interval: string): number {
    const match = interval.match(/^(\d+)(minute|min|m|hour|h|day|d)$/i);
    if (!match) {
      console.warn(`Invalid interval format: ${interval}, defaulting to 5 minutes`);
      return 5 * 60 * 1000;
    }

    const value = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();

    switch (unit) {
      case 'minute':
      case 'min':
      case 'm':
        return value * 60 * 1000;
      case 'hour':
      case 'h':
        return value * 60 * 60 * 1000;
      case 'day':
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      default:
        return 5 * 60 * 1000;
    }
  }
/**
   * Load today's historical candles from Kite API
   */
  private async loadTodayHistoricalCandles(idxRow: Instrument): Promise<void> {
    try {
      const token = Number(idxRow['instrument_token']);
      
      // Get today's date at market open (09:15)
      const today = new Date();
      const marketOpen = new Date(today);
      marketOpen.setHours(9, 15, 0, 0);
      
      // If before market open, use yesterday
      if (today < marketOpen) {
        marketOpen.setDate(marketOpen.getDate() - 1);
      }
      
      const toDate = new Date();
      
      console.info(
        `📥 Fetching historical candles from ${marketOpen.toTimeString().slice(0, 8)} ` +
        `to ${toDate.toTimeString().slice(0, 8)}`
      );
      
      const rawCandles = await this.kite.getHistoricalData(
        token,
        this.config.interval,
        marketOpen,
        toDate
      );
      
      if (rawCandles && Array.isArray(rawCandles) && rawCandles.length > 0) {
        this.candleHistory = parseCandles(rawCandles);
        this.historicalCandlesLoaded = true;
        console.info(`✅ Loaded ${this.candleHistory.length} historical candles`);
      } else {
        console.warn('⚠️  No historical candles returned');
        this.candleHistory = [];
      }
    } catch (e: any) {
      console.error('❌ Failed to load historical candles:', e?.message ?? e);
      this.candleHistory = [];
    }
  }


  /**
   * Initialize the trading engine
   */
  async initialize(): Promise<void> {
    console.info('🚀 Initializing Ticker-Based Trading Engine...');

    // Load instruments — auto-download from Kite API if stale (not from today)
    this.instruments = await ensureFreshInstruments(this.kite, this.config.instrumentsFile);
    console.info(`📊 Loaded ${this.instruments.length} instruments`);

    // Load today's historical candles BEFORE loading box
    const idxRow = findIndexRow(this.instruments, this.config.indexSymbol);
    if (idxRow) {
      await this.loadTodayHistoricalCandles(idxRow);  // ADD THIS LINE
    }

    // Load persisted box if available
    this.boxData = loadBoxFromFile(this.config.boxJsonFile);

    // Initialize ticker
    const tickerConfig: TickerConfig = {
      apiKey: this.config.apiKey,
      accessToken: this.config.accessToken,
      reconnect: true,
      maxRetry: 50,
      maxDelay: 60
    };

    this.tickerManager.initialize(tickerConfig);

    // Connect ticker
    try {
      await this.tickerManager.connect();
      console.info('✅ Ticker WebSocket connected');
    } catch (e: any) {
      console.error('❌ Failed to connect ticker:', e?.message ?? e);
      throw e;
    }

    console.info('✅ Ticker-Based Trading Engine initialized');
  }

  /**
   * Main trading loop using WebSocket
   */
  async run(): Promise<void> {
    console.info('▶️ Starting NIFTY Breakout Trading Algorithm (Ticker Mode)');

    // Find index instrument
    const idxRow = findIndexRow(this.instruments, this.config.indexSymbol);
    if (!idxRow) {
      console.error('❌ Could not find index in instruments. Check instruments.csv.');
      return;
    }

    const indexToken = Number(idxRow['instrument_token']);
    this.state.indexToken = indexToken;
    this.state.indexSymbol = idxRow['tradingsymbol'] ?? this.config.indexSymbol;

    console.info(`✅ Index found: ${this.state.indexSymbol} (Token: ${indexToken})`);

    // Calculate expiry
    const expiryDate = nearestWeeklyExpiry();
    console.info(`📅 Using expiry: ${dateOnlyString(expiryDate)}`);

    this.isRunning = true;

    // Subscribe to index for real-time price updates
    this.tickerManager.subscribeBySymbol(
      this.state.indexSymbol,
      indexToken,
      'full',
      (tick) => this.onIndexTick(tick, idxRow, expiryDate)
    );

    // Start candle aggregation
    this.startCandleAggregation();

    // Setup market close handler
    this.setupMarketCloseHandler();

    // Keep the engine running
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isRunning) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Handle incoming index tick
   */
  private async onIndexTick(
    tick: TickData,
    idxRow: Instrument,
    expiryDate: Date
  ): Promise<void> {
    if (!this.isRunning) return;

    this.state.currentPrice = tick.last_price;

    // Update current candle
    this.updateCurrentCandle(tick);

    // Emit price update event
    this.emit('price', tick.last_price, tick);
  }

  /**
   * Update current candle with tick data
   */
  private updateCurrentCandle(tick: TickData): void {
    const now = new Date();
    const candleStart = this.getCandleStartTime(now);

    if (!this.state.currentCandle || 
        this.state.currentCandle.startTime.getTime() !== candleStart.getTime()) {
      // New candle started
      if (this.state.currentCandle) {
        const completedCandle: Candle = {
          date: this.state.currentCandle.startTime,
          open: this.state.currentCandle.open,
          high: this.state.currentCandle.high,
          low: this.state.currentCandle.low,
          close: this.state.currentCandle.close
        };
        
        // Check if this candle already exists in history (from historical API)
        const existingIndex = this.candleHistory.findIndex(
          c => c.date.getTime() === completedCandle.date.getTime()
        );
        
        if (existingIndex >= 0) {
          // Replace with ticker-built candle (more accurate)
          this.candleHistory[existingIndex] = completedCandle;
          console.info(`🔄 Updated historical candle at ${completedCandle.date.toTimeString().slice(0, 8)}`);
        } else {
          // Add new candle
          this.candleHistory.push(completedCandle);
        }

        // Keep only last 300 candles (covers full trading day)
        if (this.candleHistory.length > 300) {
          this.candleHistory.shift();
        }

        // Process completed candle
        this.onCandleComplete(this.state.currentCandle);
      }

      // Start new candle
      this.state.currentCandle = {
        open: tick.last_price,
        high: tick.last_price,
        low: tick.last_price,
        close: tick.last_price,
        startTime: candleStart
      };
    } else {
      // Update current candle
      const candle = this.state.currentCandle;
      candle.high = Math.max(candle.high, tick.last_price);
      candle.low = Math.min(candle.low, tick.last_price);
      candle.close = tick.last_price;
    }
  }

  /**
   * Get candle start time based on interval
   */
  private getCandleStartTime(date: Date): Date {
    const ms = date.getTime();
    const startMs = Math.floor(ms / this.candleIntervalMs) * this.candleIntervalMs;
    return new Date(startMs);
  }

  /**
   * Resets all intraday state at the start of a new trading day.
   * Called automatically when the first candle of a new date is processed.
   */
  private resetDailyState(newDate: string): void {
    console.info(`🔄 New trading day detected (${newDate}) — resetting daily state...`);
    this.boxData = null;
    this.lastTradeDate = null;
    this.lastTradeCandleTime = null;
    this.state.lastCandleProcessed = null;
    this.candleHistory = [];
    this.processedCandleTimes.clear();
    console.info('✅ Daily state reset complete');
  }

  /**
   * Handle completed candle
   */
  private async onCandleComplete(candle: {
    open: number;
    high: number;
    low: number;
    close: number;
    startTime: Date;
  }): Promise<void> {
    const candleTimeStr = candle.startTime.toISOString();
    const todayStr = dateOnlyString(new Date());

    // Reset all intraday state when a new trading day begins
    if (this.lastTradeDate !== null && this.lastTradeDate !== todayStr) {
      this.resetDailyState(todayStr);
    }

    // CRITICAL: Skip if this candle was already processed (prevents duplicate trades)
    // This can happen when both tick-based and timer-based candle completion fire
    if (this.state.lastCandleProcessed === candleTimeStr) {
      return;
    }

    // Mark this candle as processed IMMEDIATELY to prevent race conditions
    this.state.lastCandleProcessed = candleTimeStr;
    this.processedCandleTimes.add(candleTimeStr);

    // Stamp the current date so next-day detection works even on no-trade days
    if (!this.lastTradeDate) {
      this.lastTradeDate = todayStr;
    }

    console.info(
      `📊 Candle Complete: O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} ` +
      `L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} @ ${candle.startTime.toTimeString().slice(0, 8)}`
    );

    // Skip if already traded on this candle
    if (this.lastTradeCandleTime === candleTimeStr) {
      return;
    }

    // Get index row
    const idxRow = findIndexRow(this.instruments, this.config.indexSymbol);
    if (!idxRow) return;

    // Compute box if needed
    await this.computeBoxIfNeeded(idxRow, todayStr);

    // CRITICAL: Only proceed if box is computed with valid boxHigh and boxLow
    if (!this.boxData || this.boxData.boxHigh == null || this.boxData.boxLow == null) {
      console.info('⏳ Waiting for box computation - boxHigh and boxLow required for trading');
      return;
    }

    // Create candle object for signal detection
    const lastCandle: Candle = {
      date: candle.startTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    };

    // Detect signal
    const signal = this.detectTradingSignal(lastCandle);

    // Execute trade if signal is valid
    if (signal) {
      const expiryDate = nearestWeeklyExpiry();
      const executed = await this.executeTradeIfValid(
        signal,
        idxRow,
        expiryDate,
        todayStr,
        candleTimeStr,
        this.candleHistory,
        lastCandle
      );

      if (executed) {
        this.lastTradeDate = todayStr;
        this.lastTradeCandleTime = candleTimeStr;
      }
    }
  }

  /**
   * Start candle aggregation timer
   */
  private startCandleAggregation(): void {
    // Calculate time until next candle
    const now = new Date();
    const currentCandleStart = this.getCandleStartTime(now);
    const nextCandleStart = new Date(currentCandleStart.getTime() + this.candleIntervalMs);
    const msUntilNextCandle = nextCandleStart.getTime() - now.getTime();

    console.info(`⏰ Next candle in ${Math.round(msUntilNextCandle / 1000)}s`);

    // Set timer for candle completion
    this.candleTimer = setTimeout(() => {
      // Process current candle if exists
      if (this.state.currentCandle) {
        this.onCandleComplete(this.state.currentCandle);
      }

      // Setup recurring timer
      this.candleTimer = setInterval(() => {
        if (this.state.currentCandle) {
          this.onCandleComplete(this.state.currentCandle);
        }
      }, this.candleIntervalMs);
    }, msUntilNextCandle);
  }

  /**
   * Computes box if needed for today
   */
  private async computeBoxIfNeeded(idxRow: Instrument, todayStr: string): Promise<void> {
    const now = new Date();
    const nowTimeStr = now.toTimeString().slice(0, 5);

    if ((!this.boxData || this.boxData.date !== todayStr) && nowTimeStr >= this.config.boxEnd) {
      const token = Number(idxRow['instrument_token']);

      const boxConfig: BoxConfig = {
        boxStart: this.config.boxStart,
        boxEnd: this.config.boxEnd,
        interval: this.config.interval,
        boxJsonFile: this.config.boxJsonFile,
        boxBreakMargin: this.config.boxBreakMargin
      };

      this.boxData = await computeBoxForToday(this.kite, token, boxConfig);
      console.info(`📦 Box computed: High=${this.boxData?.boxHigh?.toFixed(2)} Low=${this.boxData?.boxLow?.toFixed(2)}`);
    }
  }

  /**
   * Detects trading signal from candle
   */
  private detectTradingSignal(lastCandle: Candle): SignalType {
    const signalConfig: SignalConfig = {
      boxBreakMargin: this.config.boxBreakMargin
    };

    return detectSignal(lastCandle, this.boxData, signalConfig);
  }

  /**
   * Executes trade if all validation passes
   */
  private async executeTradeIfValid(
    signal: SignalType,
    idxRow: Instrument,
    expiryDate: Date,
    todayStr: string,
    candleTimeStr: string,
    allCandles: Candle[],
    lastCandle: Candle
  ): Promise<boolean> {
    if (!signal) return false;

    const tradeConfig: TradeConfig = {
      tradesFile: this.config.tradesFile,
      currentTradeFile: this.config.currentTradeFile
    };

    // Check if there's already an active trade
    const currentTrade = loadCurrentTrade(tradeConfig.currentTradeFile);
    if (currentTrade && currentTrade.status === 'OPEN') {
      console.info(
        `⚠️ Active trade exists: ${currentTrade.tradingsymbol} (${currentTrade.signal})`
      );
      return false;
    }

    // Check if we've already processed this candle
    if (this.lastTradeDate === todayStr && this.lastTradeCandleTime === candleTimeStr) {
      console.info('⚠️ Already processed this candle breakout');
      return false;
    }

    // Check for re-entry validation OR first trade fresh breakout validation
    const todayTrades = getTodayClosedTrades(todayStr, tradeConfig.tradesFile);
    const signalConfig = { boxBreakMargin: this.config.boxBreakMargin };

    if (todayTrades.length > 0 && this.boxData) {
      // RE-ENTRY: There were previous trades today
      const lastClosedTrade = todayTrades[todayTrades.length - 1];
      if (lastClosedTrade) {
        console.info(
          `📋 Previous trade today: ${lastClosedTrade.tradingsymbol} (${lastClosedTrade.signal}) | Exit: ${lastClosedTrade.exitReason ?? 'unknown'}`
        );

        const lastExitTime = lastClosedTrade.exitTime
          ? this.parseExitTime(todayStr, lastClosedTrade.exitTime)
          : undefined;

        const isValidReEntry = validateReEntry(
          signal,
          lastCandle,
          allCandles,
          this.boxData,
          signalConfig,
          lastExitTime
        );

        if (!isValidReEntry) {
          console.info('❌ Re-entry validation failed - box boundary not broken again');
          return false;
        }
      }
    } else if (this.boxData) {
      // FIRST TRADE: No previous trades today - but still need to validate fresh breakout!
      // Only use candles the engine processed live; historical candles loaded at startup
      // were never traded and must not block the first signal of the session.
      console.info(`🆕 First trade of the day - validating fresh breakout...`);

      const liveCandles = allCandles.filter(c => this.processedCandleTimes.has(c.date.toISOString()));
      const freshBreakoutResult = validateFreshBreakout(
        signal,
        lastCandle,
        liveCandles,
        this.boxData,
        signalConfig
      );

      if (!freshBreakoutResult.isValid) {
        console.info(`❌ First trade rejected: ${freshBreakoutResult.reason}`);
        return false;
      }

      console.info(`✅ ${freshBreakoutResult.reason}`);
    }

    // Check if price returned to box (for re-entry tracking)
    let priceReturnedToBox = false;
    let returnToBoxCandle: Candle | undefined;

    if (todayTrades.length > 0 && this.boxData) {
      const lastClosedTrade = todayTrades[todayTrades.length - 1];
      if (lastClosedTrade?.exitTime) {
        const lastExitTime = this.parseExitTime(todayStr, lastClosedTrade.exitTime);
        const candlesAfterExit = allCandles.filter(c => c.date > lastExitTime);

        for (const candle of candlesAfterExit) {
          if (this.boxData.boxLow !== null && this.boxData.boxHigh !== null &&
              candle.close >= this.boxData.boxLow && candle.close <= this.boxData.boxHigh) {
            priceReturnedToBox = true;
            returnToBoxCandle = candle;
            break;
          }
        }
      }
    }

    // Execute the trade with breakout candle info
    return await this.executeTrade(signal, idxRow, expiryDate, tradeConfig, lastCandle, todayTrades.length > 0, priceReturnedToBox, returnToBoxCandle);
  }

  /**
   * Parse exit time string to Date object
   */
  private parseExitTime(todayStr: string, exitTime: string): Date {
    const [hours, minutes, seconds] = exitTime.split(':').map(Number);
    const date = new Date(todayStr);
    date.setHours(hours ?? 0, minutes ?? 0, seconds ?? 0, 0);
    return date;
  }

  /**
   * Executes the actual trade with ticker-based monitoring
   */
  private async executeTrade(
    signal: SignalType,
    idxRow: Instrument,
    expiryDate: Date,
    tradeConfig: TradeConfig,
    breakoutCandle?: Candle,
    isReEntry: boolean = false,
    priceReturnedToBox: boolean = false,
    returnToBoxCandle?: Candle
  ): Promise<boolean> {
    if (!signal) return false;

    try {
      const tradingsymbol = idxRow['tradingsymbol'];
      if (!tradingsymbol) {
        console.error('❌ Trading symbol not found');
        return false;
      }

      // Use ticker price instead of API call
      const spot = this.state.currentPrice || await getSpotLTP(
        this.kite,
        tradingsymbol,
        this.state.indexToken
      );

      if (!spot) {
        console.error('❌ Failed to get spot price');
        return false;
      }

      console.info(`💹 Spot Price: ₹${spot.toFixed(2)}`);

      // Calculate strike and option type
      const { strike, optionType } = calculateStrikeAndType(
        signal,
        spot,
        this.config.roundStrikeTo
      );

      console.info(
        `🎯 Signal ${signal} | Strike=${strike} ${optionType} | Expiry=${dateOnlyString(expiryDate)}`
      );

      // Find option instrument
      const underlyingSym = (idxRow['tradingsymbol'] ?? 'NIFTY')
        .toString()
        .split(' ')[0] ?? 'NIFTY';
      const optRow = findOptionInstrument(
        this.instruments,
        underlyingSym,
        expiryDate,
        strike,
        optionType
      );

      if (!optRow) {
        console.warn(`❌ Option not found for ${strike} ${optionType}`);
        return false;
      }

      const lot = Number(optRow['lot_size'] || 1);
      const qty = lot * this.config.lotMultiplier;
      const optTradingsymbol = optRow['tradingsymbol'];
      const optToken = Number(optRow['instrument_token']);

      if (!optTradingsymbol) {
        console.warn(`❌ Option trading symbol not found`);
        return false;
      }

      console.info(`📤 Placing BUY order: ${optTradingsymbol} x ${qty}`);

      const orderConfig: OrderConfig = {
        exchange: this.config.exchange,
        product: this.config.product,
        validity: this.config.validity,
        variety: this.config.variety
      };

      // Place order
      const orderResp = await placeBuyOrder(this.kite, optRow, qty, orderConfig);
      console.info('✅ Order response:', orderResp);

      const orderId = orderResp?.order_id || orderResp?.orderId || undefined;

      // Wait for order execution
      await new Promise<void>(r => setTimeout(r, 1000));

      // Subscribe to option for real-time price and wait for first tick
      this.tickerManager.subscribeBySymbol(optTradingsymbol, optToken, 'full');
      
      // Wait for fill price from ticker
      let fillPrice: number;
      try {
        fillPrice = await this.tickerManager.waitForPrice(optToken, 5000);
      } catch (e) {
        // Fallback to API
        const apiPrice = await getOptionLTP(this.kite, optTradingsymbol);
        if (!apiPrice) {
          console.warn('⚠️ Could not fetch entry price');
          return false;
        }
        fillPrice = apiPrice;
      }

      console.info(`💰 Entry price: ₹${fillPrice.toFixed(2)}`);

      // Calculate SL and Target
      const { stopLoss, target } = calculateLevels(
        fillPrice,
        this.config.slBuffer,
        this.config.targetMin
      );

      console.info(
        `📊 ${signal} Trade | Entry=₹${fillPrice.toFixed(2)} | SL=₹${stopLoss.toFixed(2)} | Target=₹${target.toFixed(2)}`
      );

      // Build trade reason
      let tradeReason: TradeReason | undefined;
      if (breakoutCandle && this.boxData) {
        tradeReason = {
          breakoutCandle: {
            date: breakoutCandle.date.toISOString(),
            open: breakoutCandle.open,
            high: breakoutCandle.high,
            low: breakoutCandle.low,
            close: breakoutCandle.close
          },
          boxAtEntry: {
            boxHigh: this.boxData.boxHigh ?? 0,
            boxLow: this.boxData.boxLow ?? 0
          },
          breakoutDirection: signal === 'BULL' ? 'ABOVE' : 'BELOW',
          isReEntry,
          priceReturnedToBox,
          // Ensure returnToBoxCandle matches TradeReason type (provide safe default when undefined)
          returnToBoxCandle: returnToBoxCandle ? {
            date: returnToBoxCandle.date.toISOString(),
            close: returnToBoxCandle.close
          } : {
            date: '',
            close: 0
          }
        };
      } else {
        tradeReason = undefined;
      }

      // Record trade entry with trade reason
      const trade = recordTradeEntry(
        signal,
        optTradingsymbol,
        strike,
        optionType,
        qty,
        fillPrice,
        stopLoss,
        target,
        tradeConfig,
        orderId,
        tradeReason,
        isPaperTradeMode()
      );

      notify(
        `${signal} Trade Executed`,
        `${optTradingsymbol} | Entry ₹${fillPrice.toFixed(2)} | SL ₹${stopLoss.toFixed(2)} | Target ₹${target.toFixed(2)}`
      );

      // Broadcast trade opened via WebSocket
      if (typeof global !== 'undefined' && (global as any).wsBroadcast) {
        (global as any).wsBroadcast('trade_update', { type: 'OPENED', trade });
      }

      // Add breakout event
      if (typeof global !== 'undefined' && (global as any).addBreakoutEvent && breakoutCandle && this.boxData) {
        (global as any).addBreakoutEvent({
          type: 'BOX_BREAK',
          direction: signal,
          candle: {
            date: breakoutCandle.date.toISOString(),
            open: breakoutCandle.open,
            high: breakoutCandle.high,
            low: breakoutCandle.low,
            close: breakoutCandle.close
          },
          boxHigh: this.boxData.boxHigh,
          boxLow: this.boxData.boxLow
        });
      }

      // Start ticker-based monitoring
      const monitorConfig: MonitorConfig = {
        marketCloseTime: this.config.marketCloseTime,
        timeoutSeconds: 24 * 60 * 60,
        trailingSL: this.config.trailingStopLoss
      };

      this.activeMonitor = new TickerPositionMonitor(
        this.kite,
        monitorConfig,
        orderConfig,
        tradeConfig
      );

      // Start monitoring (non-blocking)
      this.activeMonitor.monitor(
        optTradingsymbol,
        optToken,
        fillPrice,
        qty,
        stopLoss,
        target,
        signal === 'BULL'
      ).then(() => {
        console.info('✅ Position monitoring completed');
        this.activeMonitor = null;
      }).catch((e: any) => {
        console.error('❌ Position monitoring error:', e?.message ?? e);
        this.activeMonitor = null;
      });

      return true;
    } catch (e: any) {
      console.error('❌ Failed to execute trade:', e?.message ?? e);
      notify('Trade Failed', e?.message ?? 'Unknown error — check terminal');
      return false;
    }
  }

  /**
   * Setup market close handler
   */
  private setupMarketCloseHandler(): void {
    const now = new Date();
    const [hours, minutes] = this.config.marketCloseTime.split(':').map(Number);

    const closeTime = new Date();
    closeTime.setHours(hours ?? 15, minutes ?? 30, 0, 0);

    const msUntilClose = closeTime.getTime() - now.getTime();

    if (msUntilClose > 0) {
      setTimeout(() => {
        console.info('🔔 EOD time reached. Stopping engine.');
        this.stop();
      }, msUntilClose);
    }
  }

  /**
   * Stop the trading engine
   */
  stop(): void {
    console.info('⏹️ Stopping Ticker Trading Engine...');
    this.isRunning = false;

    // Stop candle timer
    if (this.candleTimer) {
      clearTimeout(this.candleTimer);
      clearInterval(this.candleTimer);
      this.candleTimer = null;
    }

    // Stop active monitor
    if (this.activeMonitor) {
      this.activeMonitor.stop();
    }

    // Disconnect ticker
    this.tickerManager.disconnect();

    this.emit('stopped');
    console.info('✅ Ticker Trading Engine stopped');
  }

  /**
   * Get current state
   */
  getState(): Readonly<TickerEngineState> {
    return { ...this.state };
  }

  /**
   * Check if engine is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get active position monitor (for level updates)
   */
  getActiveMonitor(): TickerPositionMonitor | null {
    return this.activeMonitor;
  }

  /**
   * Resume monitoring for a trade that's already OPEN (e.g. loaded from
   * current_trade.json after a restart). Attaches to this engine's existing
   * ticker connection rather than opening a second one — Kite only allows
   * one live WebSocket connection per access token, so a second connection
   * attempt hangs/times out and can disrupt the first.
   */
  resumeTrade(trade: {
    tradingsymbol: string;
    entryPrice: number;
    quantity: number;
    stopLoss: number;
    target: number;
    signal: string;
  }): boolean {
    const row = this.instruments.find(r => r['tradingsymbol'] === trade.tradingsymbol);
    if (!row) {
      console.error(`❌ Could not find instrument for ${trade.tradingsymbol} to resume monitoring`);
      return false;
    }
    const optToken = Number(row['instrument_token']);

    const monitorConfig: MonitorConfig = {
      marketCloseTime: this.config.marketCloseTime,
      timeoutSeconds: 24 * 60 * 60,
      trailingSL: this.config.trailingStopLoss
    };
    const orderConfig: OrderConfig = {
      exchange: this.config.exchange,
      product: this.config.product,
      validity: this.config.validity,
      variety: this.config.variety
    };
    const tradeConfig: TradeConfig = {
      tradesFile: this.config.tradesFile,
      currentTradeFile: this.config.currentTradeFile
    };

    console.info(`🔄 Resuming monitoring for ${trade.tradingsymbol} on existing ticker connection`);

    this.activeMonitor = new TickerPositionMonitor(this.kite, monitorConfig, orderConfig, tradeConfig);

    this.activeMonitor.monitor(
      trade.tradingsymbol,
      optToken,
      trade.entryPrice,
      trade.quantity,
      trade.stopLoss,
      trade.target,
      trade.signal === 'BULL'
    ).then(() => {
      console.info('✅ Position monitoring completed');
      this.activeMonitor = null;
    }).catch((e: any) => {
      console.error('❌ Position monitoring error:', e?.message ?? e);
      this.activeMonitor = null;
    });

    return true;
  }

  /**
   * Get box data
   */
  getBoxData(): BoxData | null {
    return this.boxData;
  }
}

function notify(title: string, message: string): void {
  const safe = (s: string) => s.replace(/"/g, '\\"');
  exec(`osascript -e 'display notification "${safe(message)}" with title "${safe(title)}" sound name "Glass"'`);
}

/**
 * Utility: Get date-only string (YYYY-MM-DD)
 */
function dateOnlyString(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/**
 * Factory function to create and start ticker-based trading engine
 */
export async function startTickerTradingEngine(
  kite: any,
  config: TradingConfig
): Promise<TickerTradingEngine> {
  const engine = new TickerTradingEngine(kite, config);
  await engine.initialize();
  
  // Run in background
  engine.run().catch(e => {
    console.error('❌ Trading engine error:', e?.message ?? e);
  });

  return engine;
}
