/**
 * Order Management Module
 * Handles order placement and execution
 * Supports Paper Trading Mode for testing without real orders
 */

import { Instrument } from '../instruments/parser';

// Paper trading mode flag - controlled by environment variable
let paperTradeMode = process.env.PAPER_TRADE_MODE === 'true';

// Paper trade counter for generating fake order IDs
let paperOrderCounter = 1000000;

/**
 * Enable or disable paper trading mode
 */
export function setPaperTradeMode(enabled: boolean): void {
  paperTradeMode = enabled;
  console.info(`📝 Paper Trade Mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * Check if paper trading mode is enabled
 */
export function isPaperTradeMode(): boolean {
  return paperTradeMode;
}

/**
 * Generate a paper trade order ID
 */
function generatePaperOrderId(): string {
  return `PAPER_${Date.now()}_${paperOrderCounter++}`;
}

export interface OrderConfig {
  exchange: string;
  product: string;
  validity: string;
  variety: string;
}

export interface OrderResponse {
  order_id?: string;
  orderId?: string;
  status?: string;
  [key: string]: any;
}

/**
 * Gets the last traded price for an instrument
 */
export async function getSpotLTP(
  kite: any,
  tradingsymbol: string,
  instrumentToken?: number
): Promise<number | null> {
  const nameKey = `NSE:${tradingsymbol}`;
  
  // Try getLTP with symbol string first
  try {
    if (typeof kite.getLTP === 'function') {
      const q: any = await kite.getLTP([nameKey]);
      const v: any = q[nameKey] || Object.values(q)[0];
      return v && v.last_price ? Number(v.last_price) : null;
    } else if (typeof kite.ltp === 'function') {
      const q: any = await kite.ltp(nameKey);
      const v: any = Object.values(q)[0];
      return v && v.last_price ? Number(v.last_price) : null;
    }
  } catch (e: any) {
    console.warn('LTP by name failed:', e?.message ?? e);
  }
  
  // Fallback: use instrument token
  if (instrumentToken) {
    try {
      if (typeof kite.getLTP === 'function') {
        const q: any = await kite.getLTP([instrumentToken]);
        const v: any = Object.values(q)[0];
        return v && v.last_price ? Number(v.last_price) : null;
      } else if (typeof kite.ltp === 'function') {
        const q: any = await kite.ltp({ [instrumentToken]: 'instrument' });
        const v: any = Object.values(q)[0];
        return v && v.last_price ? Number(v.last_price) : null;
      }
    } catch (e: any) {
      console.warn('LTP by token failed:', e?.message ?? e);
    }
  }
  
  throw new Error('Unable to fetch spot LTP');
}

/**
 * Gets the last traded price for an option
 */
export async function getOptionLTP(
  kite: any,
  tradingsymbol: string
): Promise<number | null> {
  const nameKey = `NFO:${tradingsymbol}`;
  
  try {
    if (typeof kite.getLTP === 'function') {
      const q: any = await kite.getLTP([nameKey]);
      const v: any = Object.values(q)[0];
      return v && v.last_price ? Number(v.last_price) : null;
    } else if (typeof kite.ltp === 'function') {
      const q: any = await kite.ltp(nameKey);
      const v: any = Object.values(q)[0];
      return v && v.last_price ? Number(v.last_price) : null;
    }
  } catch (e: any) {
    console.warn('Option LTP fetch failed:', e?.message ?? e);
  }
  
  return null;
}

// Zerodha NFO doesn't allow pure MARKET orders via API.
// We use LIMIT orders at LTP + this % buffer to get market-like fills.
const LIMIT_SLIP_PCT = Number(process.env.LIMIT_SLIP_PCT || 0.02); // 2% default

/**
 * Rounds a price to the nearest valid NFO tick (0.05 for options).
 */
function roundToTick(price: number, tick = 0.05): number {
  return Math.round(price / tick) * tick;
}

/**
 * Fetches LTP for an NFO option and returns a limit price with slippage buffer.
 * BUY → LTP * (1 + slip), SELL → LTP * (1 − slip)
 */
async function limitPriceFromLTP(
  kite: any,
  tradingsymbol: string,
  side: 'BUY' | 'SELL'
): Promise<number> {
  const ltp = await getOptionLTP(kite, tradingsymbol);
  if (!ltp || ltp <= 0) throw new Error(`Cannot fetch LTP for ${tradingsymbol}`);
  const slipped = side === 'BUY' ? ltp * (1 + LIMIT_SLIP_PCT) : ltp * (1 - LIMIT_SLIP_PCT);
  return roundToTick(slipped);
}

/**
 * Places a limit buy order at LTP + buffer (or simulates in paper trade mode).
 */
export async function placeBuyOrder(
  kite: any,
  instrument: Instrument,
  quantity: number,
  config: OrderConfig
): Promise<OrderResponse> {
  const tradingsymbol = instrument['tradingsymbol'];
  if (!tradingsymbol) throw new Error('Instrument is missing tradingsymbol');
  const exchange = instrument['exchange'] || config.exchange;

  // Paper Trade Mode - simulate order without placing real order
  if (paperTradeMode) {
    const paperId = generatePaperOrderId();
    console.info('\n' + '='.repeat(60));
    console.info('📝 PAPER TRADE - BUY ORDER SIMULATED');
    console.info('='.repeat(60));
    console.info(`  Order ID:     ${paperId}`);
    console.info(`  Symbol:       ${tradingsymbol}`);
    console.info(`  Quantity:     ${quantity}`);
    console.info(`  Exchange:     ${exchange}`);
    console.info(`  Product:      ${config.product}`);
    console.info(`  Type:         LIMIT BUY (paper)`);
    console.info('='.repeat(60) + '\n');

    return {
      order_id: paperId,
      orderId: paperId,
      status: 'COMPLETE',
      paper_trade: true
    };
  }

  // Real order placement — LIMIT at LTP + buffer (Zerodha NFO requirement)
  const limitPrice = await limitPriceFromLTP(kite, tradingsymbol, 'BUY');

  const orderParams = {
    exchange,
    tradingsymbol,
    transaction_type: kite.TRANSACTION_TYPE_BUY || 'BUY',
    quantity: Number(quantity),
    price: limitPrice,
    order_type: kite.ORDER_TYPE_LIMIT || 'LIMIT',
    product: config.product,
    validity: config.validity,
  };

  try {
    if (typeof kite.placeOrder === 'function') {
      const response = await kite.placeOrder(config.variety, orderParams);
      console.info(`✅ BUY LIMIT order placed: ${tradingsymbol} x ${quantity} @ ₹${limitPrice}`);
      return response;
    }
    throw new Error('placeOrder API not found on kite client');
  } catch (e) {
    const err: any = e;
    console.error('❌ Order placement failed:', err?.message ?? err);
    throw e;
  }
}

/**
 * Places a limit sell order at LTP − buffer (or simulates in paper trade mode).
 */
export async function placeSellOrder(
  kite: any,
  tradingsymbol: string,
  quantity: number,
  config: OrderConfig
): Promise<OrderResponse> {
  // Paper Trade Mode - simulate order without placing real order
  if (paperTradeMode) {
    const paperId = generatePaperOrderId();
    console.info('\n' + '='.repeat(60));
    console.info('📝 PAPER TRADE - SELL ORDER SIMULATED');
    console.info('='.repeat(60));
    console.info(`  Order ID:     ${paperId}`);
    console.info(`  Symbol:       ${tradingsymbol}`);
    console.info(`  Quantity:     ${quantity}`);
    console.info(`  Exchange:     ${config.exchange}`);
    console.info(`  Product:      ${config.product}`);
    console.info(`  Type:         LIMIT SELL (paper)`);
    console.info('='.repeat(60) + '\n');

    return {
      order_id: paperId,
      orderId: paperId,
      status: 'COMPLETE',
      paper_trade: true
    };
  }

  // Real order placement — LIMIT at LTP − buffer (Zerodha NFO requirement)
  const limitPrice = await limitPriceFromLTP(kite, tradingsymbol, 'SELL');

  const orderParams = {
    exchange: config.exchange,
    tradingsymbol,
    transaction_type: kite.TRANSACTION_TYPE_SELL || 'SELL',
    quantity: Number(quantity),
    price: limitPrice,
    order_type: kite.ORDER_TYPE_LIMIT || 'LIMIT',
    product: config.product,
    validity: config.validity,
  };

  try {
    if (typeof kite.placeOrder === 'function') {
      const response = await kite.placeOrder(config.variety, orderParams);
      console.info(`✅ SELL LIMIT order placed: ${tradingsymbol} x ${quantity} @ ₹${limitPrice}`);
      return response;
    }
    throw new Error('placeOrder API not found on kite client');
  } catch (e) {
    const err: any = e;
    console.error('❌ Exit order placement failed:', err?.message ?? err);
    throw e;
  }
}

/**
 * Calculates strike price and option type based on signal
 */
export function calculateStrikeAndType(
  signal: 'BULL' | 'BEAR',
  spotPrice: number,
  roundTo: number = 50
): { strike: number; optionType: 'CE' | 'PE' } {
  let strike: number;
  let optionType: 'CE' | 'PE';
  
  if (signal === 'BULL') {
    // For BULL: Buy CE 200 points ITM
    strike = Math.round((spotPrice - 200) / roundTo) * roundTo;
    optionType = 'CE';
  } else {
    // For BEAR: Buy PE 200 points ITM
    strike = Math.round((spotPrice + 200) / roundTo) * roundTo;
    optionType = 'PE';
  }
  
  return { strike, optionType };
}

/**
 * Calculates stop loss and target prices
 */
export function calculateLevels(
  entryPrice: number,
  slBuffer: number,
  targetMin: number
): { stopLoss: number; target: number } {
  return {
    stopLoss: entryPrice - slBuffer,
    target: entryPrice + targetMin
  };
}
