/**
 * Paper Trade Simulation — Today's Market
 * Fetches today's NIFTY 50 candles via Kite API and walks through
 * the box-breakout strategy candle by candle in paper mode.
 *
 * Run:  node simulate-today.js
 */

'use strict';
require('dotenv').config();
const { KiteConnect } = require('kiteconnect');
const fs = require('fs');
const path = require('path');

// ── Terminal colours ─────────────────────────────────────────────────────────
const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';

const g = s => `${GREEN}${s}${R}`;
const r = s => `${RED}${s}${R}`;
const y = s => `${YELLOW}${s}${R}`;
const c = s => `${CYAN}${s}${R}`;
const b = s => `${BLUE}${s}${R}`;
const m = s => `${MAGENTA}${s}${R}`;
const dim = s => `${DIM}${GRAY}${s}${R}`;
const bold = s => `${BOLD}${s}${R}`;
const pnl = n => n >= 0
  ? `${BOLD}${GREEN}+₹${n.toFixed(2)}${R}`
  : `${BOLD}${RED}-₹${Math.abs(n).toFixed(2)}${R}`;

// ── Config (mirrors TRADING_CONFIG in main-server-ticker.js) ─────────────────
const CFG = {
  NIFTY_TOKEN: 256265,          // NSE NIFTY 50 instrument token
  BOX_START_H: 9, BOX_START_M: 15,
  BOX_END_H:   9, BOX_END_M:   30,
  SL_BUFFER:    Number(process.env.SL_BUFFER   || 20),
  TARGET_MIN:   Number(process.env.TARGET_MIN  || 30),
  BOX_MARGIN:   Number(process.env.BOX_BREAK_MARGIN || 0),
  LOT_SIZE:     75,             // NIFTY lot size
  LOT_MULT:     Number(process.env.LOT_MULTIPLIER || 1),
  ROUND_STRIKE: 50,
  ITM_DEPTH:    200,            // Strike is 200 pts ITM
  INTERVAL:     '5minute',
  EOD_H: 15, EOD_M: 20,
  TRAILING_PROFIT_THRESHOLD: Number(process.env.TRAILING_SL_PROFIT_THRESHOLD || 20),
  TRAILING_NEW_SL_DISTANCE:  Number(process.env.TRAILING_SL_NEW_DISTANCE     || 10),
};

const TODAY_STR = new Date().toISOString().slice(0, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────
function hhmm(dt) {
  return dt.toTimeString().slice(0, 5);
}

function roundStrike(price) {
  return Math.round(price / CFG.ROUND_STRIKE) * CFG.ROUND_STRIKE;
}

function calcStrike(signal, spot) {
  if (signal === 'BULL') {
    return { strike: roundStrike(spot - CFG.ITM_DEPTH), optType: 'CE' };
  }
  return { strike: roundStrike(spot + CFG.ITM_DEPTH), optType: 'PE' };
}

// Nearest weekly expiry (Tuesday)
function nearestTuesdayExpiry(from = new Date()) {
  const d = new Date(from);
  const wd = d.getDay(); // 0=Sun,1=Mon,2=Tue,...
  const daysAhead = (2 - wd + 7) % 7 || 7; // next Tuesday (or today if Tuesday)
  d.setDate(d.getDate() + daysAhead);
  return d;
}

// Build option tradingsymbol like "NIFTY2601623700CE"
function buildOptionSymbol(strike, optType, expiryDate) {
  const yy  = String(expiryDate.getFullYear()).slice(2);
  const mm  = ['JAN','FEB','MAR','APR','MAY','JUN',
               'JUL','AUG','SEP','OCT','NOV','DEC'][expiryDate.getMonth()];
  const dd  = String(expiryDate.getDate()).padStart(2, '0');
  return `NIFTY${yy}${mm}${dd}${strike}${optType}`;
}

// Find option instrument token from instruments.csv
function findOptionToken(symbol) {
  const csvPath = path.resolve(process.env.INSTRUMENTS_CSV || './instruments.csv');
  if (!fs.existsSync(csvPath)) return null;

  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const headers = lines[0].split(',');
  const tokIdx = headers.indexOf('instrument_token');
  const symIdx = headers.indexOf('tradingsymbol');
  if (tokIdx < 0 || symIdx < 0) return null;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols[symIdx] === symbol) return parseInt(cols[tokIdx], 10);
  }
  return null;
}

// Detect signal per candle (mirrors detector.ts:detectSignal)
function detectSignal(candle, boxHigh, boxLow) {
  const { open, close } = candle;
  if (close > boxHigh + CFG.BOX_MARGIN && close > open) return 'BULL';
  if (close < boxLow  - CFG.BOX_MARGIN && close < open) return 'BEAR';
  return null;
}

// Check if price returned to box in a slice of candles
function priceReturnedToBox(candles, boxHigh, boxLow) {
  for (const c of candles) {
    if (c.close >= boxLow && c.close <= boxHigh) return true;
  }
  return false;
}

// ── Main simulation ───────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log(bold('       📊 NIFTY BOX BREAKOUT — PAPER SIMULATION'));
  console.log(bold(`       Date: ${TODAY_STR}`));
  console.log('═'.repeat(60));

  // ── Auth ────────────────────────────────────────────────────────────────────
  const API_KEY      = process.env.API_KEY;
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

  if (!API_KEY || !ACCESS_TOKEN) {
    console.error(r('❌  API_KEY or ACCESS_TOKEN missing in .env'));
    process.exit(1);
  }

  const kite = new KiteConnect({ api_key: API_KEY });
  kite.setAccessToken(ACCESS_TOKEN);

  // Verify session
  try {
    await kite.getProfile();
    console.log(g('✅  Kite session valid'));
  } catch (e) {
    console.error(r(`❌  Session invalid: ${e?.message}`));
    console.log(y('   → Visit http://localhost:3000/login to generate a fresh token'));
    process.exit(1);
  }

  // ── Fetch today's NIFTY 5-min candles (09:15 → 15:30) ──────────────────────
  const marketOpen  = new Date(); marketOpen.setHours(9, 15, 0, 0);
  const marketClose = new Date(); marketClose.setHours(15, 30, 0, 0);
  const now = new Date();
  const fetchTo = now < marketClose ? now : marketClose;

  console.log(`\n${c('📡')} Fetching NIFTY 50 candles (${hhmm(marketOpen)}–${hhmm(fetchTo)})…`);

  let rawCandles;
  try {
    rawCandles = await kite.getHistoricalData(
      CFG.NIFTY_TOKEN, CFG.INTERVAL, marketOpen, fetchTo
    );
  } catch (e) {
    console.error(r(`❌  Failed to fetch candles: ${e?.message}`));
    process.exit(1);
  }

  if (!rawCandles || rawCandles.length === 0) {
    console.log(y('⚠️   No candles returned — market may not have opened yet.'));
    process.exit(0);
  }

  // Parse raw candles (Kite returns arrays [ts, o, h, l, c, vol])
  const candles = rawCandles.map(c => ({
    date:   new Date(c[0] ?? c.date ?? c.time),
    open:   Number(c[1] ?? c.open),
    high:   Number(c[2] ?? c.high),
    low:    Number(c[3] ?? c.low),
    close:  Number(c[4] ?? c.close),
    volume: Number(c[5] ?? c.volume ?? 0),
  }));

  console.log(g(`✅  ${candles.length} candles fetched`));

  // ── Print chart (mini ASCII) ────────────────────────────────────────────────
  console.log(`\n${bold('── Intraday Chart (5-min NIFTY 50) ──')}`);
  console.log(dim(`${'Time'.padEnd(6)} ${'Open'.padStart(9)} ${'High'.padStart(9)} ${'Low'.padStart(9)} ${'Close'.padStart(9)}  Dir`));
  console.log(dim('─'.repeat(54)));

  for (const cd of candles) {
    const time  = hhmm(cd.date);
    const dir   = cd.close > cd.open ? g('▲') : cd.close < cd.open ? r('▼') : dim('─');
    const cl    = cd.close > cd.open
      ? `${GREEN}${cd.close.toFixed(2).padStart(9)}${R}`
      : `${RED}${cd.close.toFixed(2).padStart(9)}${R}`;
    console.log(
      `${dim(time.padEnd(6))} ${cd.open.toFixed(2).padStart(9)} ${cd.high.toFixed(2).padStart(9)} ${cd.low.toFixed(2).padStart(9)} ${cl}  ${dir}`
    );
  }

  // ── Compute Box (09:15 – 09:30) ─────────────────────────────────────────────
  const boxCandles = candles.filter(cd => {
    const h = cd.date.getHours(), m = cd.date.getMinutes();
    return (h === 9 && m >= 15 && m < 30);
  });

  if (boxCandles.length === 0) {
    console.log(y('\n⚠️   No box candles (09:15–09:30) — market may not have opened yet.'));
    process.exit(0);
  }

  const boxHigh = Math.max(...boxCandles.map(c => c.high));
  const boxLow  = Math.min(...boxCandles.map(c => c.low));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(bold('  📦 BOX LEVELS'));
  console.log('═'.repeat(60));
  console.log(`  Period:    09:15 – 09:30`);
  console.log(`  Box High:  ${g('₹' + boxHigh.toFixed(2))}`);
  console.log(`  Box Low:   ${r('₹' + boxLow.toFixed(2))}`);
  console.log(`  Range:     ₹${(boxHigh - boxLow).toFixed(2)}`);
  console.log('═'.repeat(60));

  // ── Strategy simulation ──────────────────────────────────────────────────────
  // Only look at candles AFTER box formation
  const tradingCandles = candles.filter(cd => {
    const h = cd.date.getHours(), m = cd.date.getMinutes();
    return (h > 9) || (h === 9 && m >= 30);
  });

  console.log(`\n${bold('── Signal Scan (post-box candles) ──')}`);
  console.log(dim(`  Scanning ${tradingCandles.length} candles after 09:30…\n`));

  const qty = CFG.LOT_SIZE * CFG.LOT_MULT;
  const expiry = nearestTuesdayExpiry(new Date());

  // Simulation state
  let activeTrade = null;   // { signal, symbol, entry, sl, target, qty, entryCandle, trailMoved }
  let closedTrades = [];    // array of closed trade summaries
  let lastExitCandleIdx = -1;

  function openTrade(signal, spot, entryCandle, candleIdx) {
    const { strike, optType } = calcStrike(signal, spot);
    const symbol = buildOptionSymbol(strike, optType, expiry);

    // Try to find real option token (for display/lookup purposes)
    const token = findOptionToken(symbol);

    // Entry price: use spot as proxy for option price since we don't have live option tick
    // In real paper mode the engine uses actual option LTP. Here we approximate:
    // ITM CE/PE typically ≈ intrinsic + small time value. We'll use intrinsic as proxy.
    const intrinsic = signal === 'BULL'
      ? Math.max(0, spot - strike)
      : Math.max(0, strike - spot);
    const entryPrice = intrinsic > 0 ? intrinsic : spot * 0.02; // fallback 2% of spot

    const sl     = entryPrice - CFG.SL_BUFFER;
    const target = entryPrice + CFG.TARGET_MIN;

    console.log('\n' + '─'.repeat(60));
    console.log(`  ${signal === 'BULL' ? g('🟢 BULL SIGNAL') : r('🔴 BEAR SIGNAL')} @ ${hhmm(entryCandle.date)}`);
    console.log('─'.repeat(60));
    console.log(`  Index Spot:    ₹${spot.toFixed(2)}`);
    console.log(`  Option:        ${bold(symbol)}${token ? dim(' [token: ' + token + ']') : dim(' [token not found]')}`);
    console.log(`  Strike:        ₹${strike}  (${optType}, ITM by ₹${CFG.ITM_DEPTH})`);
    console.log(`  Entry Price:   ${c('₹' + entryPrice.toFixed(2))}  ${dim('(intrinsic value proxy)')}`);
    console.log(`  Quantity:      ${qty} (${CFG.LOT_MULT} lots × ${CFG.LOT_SIZE})`);
    console.log(`  Stop Loss:     ${r('₹' + sl.toFixed(2))}  ${dim('(entry − ' + CFG.SL_BUFFER + ')')}`);
    console.log(`  Target:        ${g('₹' + target.toFixed(2))}  ${dim('(entry + ' + CFG.TARGET_MIN + ')')}`);
    console.log(`  Mode:          ${y('📝 PAPER TRADE')}`);
    console.log('─'.repeat(60));

    return {
      signal, symbol, strike, optType,
      entry: entryPrice, sl, target, qty,
      entryCandle, entryTime: hhmm(entryCandle.date),
      entryIdx: candleIdx,
      trailMoved: false,
      entrySpot: spot,
    };
  }

  function closeTrade(trade, exitPrice, reason, exitCandle) {
    const pnlAmt = (exitPrice - trade.entry) * trade.qty;
    const reasonEmoji = reason === 'TARGET' ? '🎯' : reason === 'SL' ? '🛑' : reason === 'EOD' ? '🔔' : '✋';
    const reasonStr   = reason === 'TARGET' ? g('TARGET HIT') : reason === 'SL' ? r('STOP LOSS HIT') : y(reason);

    console.log('\n' + '═'.repeat(60));
    console.log(`  ${reasonEmoji} TRADE CLOSED — ${reasonStr}`);
    console.log('═'.repeat(60));
    console.log(`  Symbol:       ${bold(trade.symbol)}`);
    console.log(`  Entry:        ${c('₹' + trade.entry.toFixed(2))}  @ ${trade.entryTime}`);
    console.log(`  Exit:         ${c('₹' + exitPrice.toFixed(2))}  @ ${hhmm(exitCandle.date)}`);
    console.log(`  Qty:          ${trade.qty}`);
    console.log(`  Per Unit P/L: ${pnl(exitPrice - trade.entry)}`);
    console.log(`  Total P/L:    ${pnl(pnlAmt)}`);
    console.log('═'.repeat(60));

    return {
      ...trade,
      exitPrice,
      exitTime: hhmm(exitCandle.date),
      reason,
      pnlAmt,
    };
  }

  // ── Walk candles ─────────────────────────────────────────────────────────────
  for (let i = 0; i < tradingCandles.length; i++) {
    const candle = tradingCandles[i];
    const timeStr = hhmm(candle.date);

    // EOD exit
    const cdH = candle.date.getHours(), cdM = candle.date.getMinutes();
    const isEOD = (cdH > CFG.EOD_H) || (cdH === CFG.EOD_H && cdM >= CFG.EOD_M);

    if (activeTrade && isEOD) {
      const exitPrice = candle.close;
      closedTrades.push(closeTrade(activeTrade, exitPrice, 'EOD', candle));
      activeTrade = null;
      lastExitCandleIdx = i;
      console.log(dim(`  ${timeStr}  Market close — EOD exit`));
      break;
    }

    // Monitor open trade
    if (activeTrade) {
      // Option price approximation: shift intrinsic by index move
      const indexMove  = candle.close - activeTrade.entrySpot;
      const deltaApprox = 0.85; // deep ITM delta ≈ 0.85
      const optionLTP = activeTrade.entry + (indexMove * deltaApprox);

      // Trailing SL
      if (!activeTrade.trailMoved && (optionLTP - activeTrade.entry) >= CFG.TRAILING_PROFIT_THRESHOLD) {
        const newSL = optionLTP - CFG.TRAILING_NEW_SL_DISTANCE;
        console.log(`  ${timeStr}  ${m('⟳ Trailing SL:')} ₹${activeTrade.sl.toFixed(2)} → ₹${newSL.toFixed(2)}`);
        activeTrade.sl = newSL;
        activeTrade.trailMoved = true;
      }

      // SL check
      if (optionLTP <= activeTrade.sl) {
        closedTrades.push(closeTrade(activeTrade, activeTrade.sl, 'SL', candle));
        activeTrade = null;
        lastExitCandleIdx = i;
        continue;
      }

      // Target check
      if (optionLTP >= activeTrade.target) {
        closedTrades.push(closeTrade(activeTrade, activeTrade.target, 'TARGET', candle));
        activeTrade = null;
        lastExitCandleIdx = i;
        continue;
      }

      // Still in trade
      const floatPnl = (optionLTP - activeTrade.entry) * activeTrade.qty;
      console.log(
        `  ${timeStr}  ${activeTrade.signal === 'BULL' ? g('▲') : r('▼')} ` +
        `NIFTY: ${candle.close.toFixed(2)}  Option≈${c('₹' + optionLTP.toFixed(2))}  ` +
        `Float P/L: ${pnl(floatPnl)}  SL: ${r('₹' + activeTrade.sl.toFixed(2))}`
      );
      continue;
    }

    // No active trade — look for signal
    const signal = detectSignal(candle, boxHigh, boxLow);

    if (!signal) {
      const boxPos = candle.close > boxHigh ? g('↑ above') :
                     candle.close < boxLow  ? r('↓ below') : dim('▣ inside box');
      console.log(
        `  ${timeStr}  O:${candle.open.toFixed(0)} H:${candle.high.toFixed(0)} ` +
        `L:${candle.low.toFixed(0)} C:${candle.close.toFixed(0)}  ${boxPos}`
      );
      continue;
    }

    // We have a signal — validate re-entry if we've had a previous trade today
    const prevCandles = tradingCandles.slice(0, i);

    if (closedTrades.length > 0 && lastExitCandleIdx >= 0) {
      const candlesAfterExit = tradingCandles.slice(lastExitCandleIdx + 1, i);
      if (!priceReturnedToBox(candlesAfterExit, boxHigh, boxLow)) {
        console.log(
          `  ${timeStr}  ${y('⚠️  RE-ENTRY REJECTED')} — price never returned to box after last exit`
        );
        continue;
      }
      console.log(`  ${timeStr}  ${g('✓ Re-entry validated')} — price returned to box`);
    }

    // Fresh breakout validation for first trade
    if (closedTrades.length === 0) {
      const prevBreakouts = prevCandles.filter(pc => {
        if (signal === 'BULL') return pc.close > boxHigh && pc.close > pc.open;
        return pc.close < boxLow && pc.close < pc.open;
      });
      if (prevBreakouts.length > 0) {
        // Check if price returned to box since last breakout
        const lastBrk = prevBreakouts[prevBreakouts.length - 1];
        const betweenCandles = prevCandles.filter(pc => pc.date > lastBrk.date);
        if (!priceReturnedToBox(betweenCandles, boxHigh, boxLow)) {
          console.log(`  ${timeStr}  ${y('⚠️  STALE BREAKOUT SKIPPED')} — already broke out at ${hhmm(lastBrk.date)}, no return to box`);
          continue;
        }
      }
    }

    // Enter trade
    activeTrade = openTrade(signal, candle.close, candle, i);
  }

  // Still open at end of data
  if (activeTrade) {
    const lastCandle = tradingCandles[tradingCandles.length - 1];
    if (lastCandle) {
      const indexMove = lastCandle.close - activeTrade.entrySpot;
      const optionLTP = activeTrade.entry + (indexMove * 0.85);
      const floatPnl  = (optionLTP - activeTrade.entry) * activeTrade.qty;
      console.log('\n' + '─'.repeat(60));
      console.log(bold('  ⏳ TRADE STILL OPEN (last tick)'));
      console.log('─'.repeat(60));
      console.log(`  Symbol:       ${bold(activeTrade.symbol)}`);
      console.log(`  Entry:        ${c('₹' + activeTrade.entry.toFixed(2))}`);
      console.log(`  Current LTP≈  ${c('₹' + optionLTP.toFixed(2))}  ${dim('(delta≈0.85 approx)')}`);
      console.log(`  Float P/L:    ${pnl(floatPnl)}`);
      console.log('─'.repeat(60));
    }
  }

  // ── Day Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(bold('  📊 SIMULATION SUMMARY — ' + TODAY_STR));
  console.log('═'.repeat(60));

  if (closedTrades.length === 0 && !activeTrade) {
    console.log(dim('  No trades taken today.'));
  } else {
    let totalPnl = 0;
    closedTrades.forEach((t, idx) => {
      totalPnl += t.pnlAmt;
      const emoji = t.pnlAmt >= 0 ? '✅' : '❌';
      console.log(
        `  ${emoji}  Trade ${idx + 1}: ${bold(t.symbol)}  ` +
        `Entry ${t.entryTime} → Exit ${t.exitTime} ` +
        `[${t.reason}]  ${pnl(t.pnlAmt)}`
      );
    });

    if (closedTrades.length > 0) {
      const winners = closedTrades.filter(t => t.pnlAmt > 0).length;
      const winRate = ((winners / closedTrades.length) * 100).toFixed(0);
      console.log('─'.repeat(60));
      console.log(`  Trades:        ${bold(closedTrades.length.toString())}`);
      console.log(`  Winners:       ${g(winners.toString())}  Losers: ${r((closedTrades.length - winners).toString())}`);
      console.log(`  Win Rate:      ${winners >= closedTrades.length / 2 ? g(winRate + '%') : r(winRate + '%')}`);
      console.log(`  ${bold('Day P/L:')}       ${pnl(totalPnl)}`);
      console.log(`  ${bold('Max per lot:')}   ${pnl(totalPnl / CFG.LOT_MULT)}`);
    }
  }

  console.log('═'.repeat(60));

  // ── Box level detail ─────────────────────────────────────────────────────────
  console.log(`\n${bold('── Box Reference ──────────────────────────────────────')}`);
  console.log(`  Box High: ${g('₹' + boxHigh.toFixed(2))}   (break UP with green candle → BUY CE)`);
  console.log(`  Box Low:  ${r('₹' + boxLow.toFixed(2))}   (break DOWN with red candle  → BUY PE)`);
  console.log(`  SL:       Entry − ${CFG.SL_BUFFER} pts`);
  console.log(`  Target:   Entry + ${CFG.TARGET_MIN} pts`);
  console.log(dim('  Note: Option prices are delta-approximated (intrinsic + 0.85×index move)'));
  console.log(dim('        For real option prices run the live server: npm run start:paper\n'));
}

main().catch(e => {
  console.error(r('\n❌ Simulation error: ' + (e?.message || e)));
  process.exit(1);
});
