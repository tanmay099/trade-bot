/**
 * TypeScript Type Definitions for Kite Ticker System
 */

// Re-export from modules
export {  TickerManager, getTickerManager } from './ticker-manager';
export { TickerPositionMonitor, monitorAndExitWithTicker, isMarketClosed, isTradingTime } from './modules/monitor/ticker-position-monitor';
export {  TickerTradingEngine, startTickerTradingEngine } from './ticker-trading-engine';

// KiteTicker types (from ticker.js)
export interface KiteTickerOptions {
  api_key: string;
  access_token: string;
  reconnect?: boolean;
  max_retry?: number;
  max_delay?: number;
}

export type KiteTickerMode = 'ltp' | 'quote' | 'full';

export interface KiteTickerTick {
  tradable: boolean;
  mode: KiteTickerMode;
  instrument_token: number;
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

export type KiteTickerEvent = 
  | 'connect'
  | 'ticks'
  | 'disconnect'
  | 'error'
  | 'close'
  | 'reconnect'
  | 'noreconnect'
  | 'message'
  | 'order_update';

export interface KiteTickerInstance {
  modeFull: string;
  modeQuote: string;
  modeLTP: string;
  
  connect(): void;
  disconnect(): boolean;
  connected(): boolean;
  
  on(event: KiteTickerEvent, callback: Function): void;
  
  subscribe(tokens: number[]): number[];
  unsubscribe(tokens: number[]): number[];
  setMode(mode: string, tokens: number[]): number[];
  
  autoReconnect(enable: boolean, max_retry?: number, max_delay?: number): void;
  parseBinary(binpacks: ArrayBuffer): KiteTickerTick[];
}

// Instrument types
export interface Instrument {
  instrument_token: string | number;
  exchange_token: string | number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

// Box types
export interface BoxData {
  date: string;
  boxHigh: number | null;
  boxLow: number | null;
  computedAt: string;
}

export interface BoxConfig {
  boxStart: string;
  boxEnd: string;
  interval: string;
  boxJsonFile: string;
  boxBreakMargin: number;
}

// Trade types
export interface Trade {
  date: string;
  signal: 'BULL' | 'BEAR';
  tradingsymbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  status: 'OPEN' | 'CLOSED';
  entryTime: string;
  exitPrice?: number;
  exitTime?: string;
  exitReason?: 'SL' | 'TARGET' | 'EOD';
  pnl?: number;
  orderId?: string;
}

export interface TradeConfig {
  tradesFile: string;
  currentTradeFile: string;
}

// Signal types
export type SignalType = 'BULL' | 'BEAR' | null;

export interface SignalConfig {
  boxBreakMargin: number;
}

export interface Candle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Utility types
export type AnyObject = { [key: string]: any };
