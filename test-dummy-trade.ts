/**
 * Dummy Trade Test Script
 * Runs a full BUY → SELL cycle through the existing modules.
 * Uses PAPER_TRADE_MODE by default (no real orders).
 * Set PAPER_TRADE_MODE=false + supply a valid ACCESS_TOKEN to hit real Kite API.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { setPaperTradeMode, isPaperTradeMode, placeBuyOrder, placeSellOrder, calculateStrikeAndType, calculateLevels } from './modules/orders/executor';
import { recordTradeEntry, recordTradeExit, printPnLSummary, TradeConfig } from './modules/trades/persistence';
import { existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const PAPER = process.env.PAPER_TRADE_MODE !== 'false'; // default true
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const API_KEY = process.env.KITE_API_KEY || '';

const DUMMY_SPOT    = 24500;   // fake/hardcoded spot price used when not fetching live
const SIGNAL: 'BULL' | 'BEAR' = (process.env.SIGNAL as 'BULL' | 'BEAR') || 'BULL';
const QUANTITY      = 50;      // 1 lot of NIFTY
const SL_BUFFER     = Number(process.env.SL_BUFFER  || 20);
const TARGET_MIN    = Number(process.env.TARGET_MIN || 30);

// Temp trade files so we don't pollute the live ones
const TRADE_CONFIG: TradeConfig = {
  tradesFile: 'test_trades.json',
  currentTradeFile: 'test_current_trade.json',
};

// ── Mock Kite client (used in paper mode or when no token is provided) ───────

function buildMockKite() {
  return {
    TRANSACTION_TYPE_BUY:  'BUY',
    TRANSACTION_TYPE_SELL: 'SELL',
    ORDER_TYPE_MARKET:     'MARKET',
    getLTP: async (keys: any[]) => {
      // Return a fake LTP so the executor doesn't fail
      const key = String(Array.isArray(keys) ? keys[0] : keys);
      return { [key]: { last_price: DUMMY_SPOT } };
    },
    placeOrder: async (_variety: string, params: any) => {
      const id = `REAL_MOCK_${Date.now()}`;
      console.log(`  [mock placeOrder] ${params.transaction_type} ${params.tradingsymbol} x${params.quantity} → ${id}`);
      return { order_id: id, status: 'COMPLETE' };
    },
  };
}

function buildRealKite() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KiteConnect } = require('kiteconnect');
  const kite = new KiteConnect({ api_key: API_KEY });
  kite.setAccessToken(ACCESS_TOKEN);
  return kite;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanup() {
  for (const f of [TRADE_CONFIG.tradesFile, TRADE_CONFIG.currentTradeFile]) {
    if (existsSync(resolve(f))) unlinkSync(resolve(f));
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  DUMMY TRADE TEST');
  console.log('═'.repeat(60));

  setPaperTradeMode(PAPER);

  const useReal = !PAPER && ACCESS_TOKEN && API_KEY;
  const kite = useReal ? buildRealKite() : buildMockKite();

  if (useReal) {
    console.log('  Mode: LIVE (real Kite API)');
  } else {
    console.log('  Mode: PAPER (simulated)');
  }
  console.log(`  Signal:   ${SIGNAL}`);
  console.log(`  Spot:     ${DUMMY_SPOT}`);
  console.log('═'.repeat(60) + '\n');

  // 1. Calculate strike and option type
  const { strike, optionType } = calculateStrikeAndType(SIGNAL, DUMMY_SPOT);
  console.log(`  Strike computed: ${strike} ${optionType}`);

  // Build a minimal Instrument object the executor expects
  const instrument = {
    tradingsymbol: `NIFTY${strike}${optionType}`,  // e.g. NIFTY2450024500CE
    exchange: 'NFO',
  };

  const orderConfig = {
    exchange: 'NFO',
    product: 'MIS',
    validity: 'DAY',
    variety: 'regular',
  };

  // 2. Place BUY order
  console.log('\n[Step 1] Placing BUY order...');
  const buyResponse = await placeBuyOrder(kite, instrument, QUANTITY, orderConfig);
  console.log('  BUY response:', JSON.stringify(buyResponse));

  // 3. Simulate entry price (in real mode you'd fetch order fill; here we use spot ± spread)
  const entryPrice = DUMMY_SPOT * 0.01 + 150; // fake option price
  const { stopLoss, target } = calculateLevels(entryPrice, SL_BUFFER, TARGET_MIN);

  // 4. Record trade entry
  console.log('\n[Step 2] Recording trade entry...');
  const trade = recordTradeEntry(
    SIGNAL,
    instrument.tradingsymbol,
    strike,
    optionType,
    QUANTITY,
    entryPrice,
    stopLoss,
    target,
    TRADE_CONFIG,
    buyResponse.order_id,
    undefined,
    isPaperTradeMode()
  );
  console.log(`  Trade recorded: entry=₹${trade.entryPrice}, SL=₹${trade.stopLoss}, target=₹${trade.target}`);

  // 5. Wait briefly (simulates holding the position)
  console.log('\n[Step 3] Holding position for 2 seconds...');
  await sleep(2000);

  // 6. Simulate exit — price hit target
  const exitPrice = target + 5; // simulate target hit
  const exitReason = 'TARGET';

  console.log(`\n[Step 4] Placing SELL order (exit at ₹${exitPrice})...`);
  const sellResponse = await placeSellOrder(kite, instrument.tradingsymbol, QUANTITY, orderConfig);
  console.log('  SELL response:', JSON.stringify(sellResponse));

  // 7. Record trade exit
  console.log('\n[Step 5] Recording trade exit...');
  recordTradeExit(exitPrice, exitReason, TRADE_CONFIG);

  // 8. Print summary
  console.log('\n[Step 6] Final P/L summary:');
  printPnLSummary(TRADE_CONFIG.tradesFile);

  // 9. Clean up test files
  cleanup();
  console.log('  Test files cleaned up. Done!\n');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
