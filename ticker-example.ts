/**
 * Simple Ticker Usage Example
 * Demonstrates basic WebSocket price streaming with Kite
 */

import { KiteTicker } from 'kiteconnect';

// Configuration
const API_KEY = process.env.API_KEY || 'your_api_key';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'your_access_token';

// Instrument tokens (from instruments.csv)
const NIFTY_50_TOKEN = 256265;
const BANKNIFTY_TOKEN = 260105;

// Create ticker instance
const ticker = new KiteTicker({
  api_key: API_KEY,
  access_token: ACCESS_TOKEN,
  reconnect: true,
  max_retry: 50,
  max_delay: 60
});

// Event handlers
function onConnect(): void {
  console.log('✅ Connected to Kite WebSocket');
  
  // Subscribe to instruments
  const tokens = [NIFTY_50_TOKEN, BANKNIFTY_TOKEN];
  ticker.subscribe(tokens);
  
  // Set mode to full for all data
  ticker.setMode('full', tokens);
  
  console.log(`📊 Subscribed to ${tokens.length} instruments`);
}

function onTicks(ticks: any[]): void {
  for (const tick of ticks) {
    const symbol = getSymbol(tick.instrument_token);
    const price = tick.last_price;
    const change = tick.change?.toFixed(2) ?? '0.00';
    
    console.log(
      `📈 ${symbol}: ₹${price.toFixed(2)} (${change}%)` +
      (tick.ohlc ? ` | O:${tick.ohlc.open} H:${tick.ohlc.high} L:${tick.ohlc.low}` : '')
    );
  }
}

function onDisconnect(error: Error): void {
  console.warn('⚠️ Disconnected:', error?.message ?? 'Unknown reason');
}

function onError(error: Error): void {
  console.error('❌ Error:', error?.message ?? error);
}

function onClose(reason: string): void {
  console.log('🔒 Connection closed:', reason);
}

function onReconnect(attempt: number, interval: number): void {
  console.log(`🔄 Reconnecting... Attempt ${attempt}, next in ${interval}s`);
}

function onNoReconnect(): void {
  console.error('❌ Max reconnection attempts reached');
}

function onOrderUpdate(order: any): void {
  console.log('📋 Order update:', order);
}

// Helper to get symbol name from token
function getSymbol(token: number): string {
  switch (token) {
    case NIFTY_50_TOKEN: return 'NIFTY 50';
    case BANKNIFTY_TOKEN: return 'BANKNIFTY';
    default: return `Token:${token}`;
  }
}

// Register event handlers
ticker.on('connect', onConnect);
ticker.on('ticks', onTicks);
ticker.on('disconnect', onDisconnect);
ticker.on('error', onError);
ticker.on('close', onClose);
ticker.on('reconnect', onReconnect);
ticker.on('noreconnect', onNoReconnect);
ticker.on('order_update', onOrderUpdate);

// Connect
console.log('🔌 Connecting to Kite WebSocket...');
ticker.connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  ticker.disconnect();
  process.exit(0);
});

/**
 * Example output:
 * 
 * 🔌 Connecting to Kite WebSocket...
 * ✅ Connected to Kite WebSocket
 * 📊 Subscribed to 2 instruments
 * 📈 NIFTY 50: ₹23456.75 (0.45%) | O:23400 H:23480 L:23380
 * 📈 BANKNIFTY: ₹49876.50 (0.32%) | O:49800 H:49950 L:49750
 * ...
 */
