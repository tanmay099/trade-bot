/**
 * Trade Persistence Module
 * Handles loading and saving trade data
 * With colorful terminal P/L summary
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

// Terminal Colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Text colors
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Background colors
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
};

// Helper for colored text
const c = {
  green: (text: string) => `${colors.green}${text}${colors.reset}`,
  red: (text: string) => `${colors.red}${text}${colors.reset}`,
  yellow: (text: string) => `${colors.yellow}${text}${colors.reset}`,
  blue: (text: string) => `${colors.blue}${text}${colors.reset}`,
  cyan: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  gray: (text: string) => `${colors.gray}${text}${colors.reset}`,
  bright: (text: string) => `${colors.bright}${text}${colors.reset}`,
  
  // P/L specific
  profit: (amount: number) => `${colors.bright}${colors.green}+₹${amount.toFixed(2)}${colors.reset}`,
  loss: (amount: number) => `${colors.bright}${colors.red}-₹${Math.abs(amount).toFixed(2)}${colors.reset}`,
  pnl: (amount: number) => amount >= 0 
    ? `${colors.bright}${colors.green}+₹${amount.toFixed(2)}${colors.reset}`
    : `${colors.bright}${colors.red}-₹${Math.abs(amount).toFixed(2)}${colors.reset}`,
};

// Trade reason tracking - why was this trade taken
export interface TradeReason {
  breakoutCandle: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
  };
  boxAtEntry: {
    boxHigh: number;
    boxLow: number;
  };
  breakoutDirection: 'ABOVE' | 'BELOW';
  isReEntry: boolean;
  priceReturnedToBox?: boolean;
  returnToBoxCandle?: {
    date: string;
    close: number;
  };
}

// Level modification tracking
export interface LevelModification {
  timestamp: string;
  field: 'stopLoss' | 'target';
  oldValue: number;
  newValue: number;
  source: 'TRAILING' | 'MANUAL';
}

export interface Trade {
  date: string;
  time: string;
  signal: string;
  tradingsymbol: string;
  strike: number;
  optionType: string;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  initialStopLoss?: number;        // Original SL at entry
  target: number;
  initialTarget?: number;          // Original target at entry
  orderId?: string | undefined;
  status: string;
  exitPrice?: number | undefined;
  exitTime?: string | undefined;
  exitReason?: 'SL' | 'TARGET' | 'EOD' | 'MANUAL' | undefined;
  pnl?: number | undefined;
  tradeReason?: TradeReason;       // Why trade was taken
  levelModifications?: LevelModification[];  // Change history
  paperTrade?: boolean;            // True if this was a simulated paper trade
}

export interface TradeConfig {
  tradesFile: string;
  currentTradeFile: string;
}

export interface PnLSummary {
  totalPnL: number;
  todayPnL: number;
  totalTrades: number;
  todayTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  todayWinners: number;
  todayLosers: number;
  todayWinRate: number;
}

/**
 * Loads all historical trades from file
 */
export function loadAllTrades(tradesFile: string): Trade[] {
  try {
    if (existsSync(resolve(tradesFile))) {
      const raw = readFileSync(resolve(tradesFile), 'utf8');
      return JSON.parse(raw || '[]');
    }
  } catch (e: any) {
    console.warn('Failed to load trades file:', e?.message ?? e);
  }
  return [];
}

/**
 * Saves all trades to file
 */
export function saveAllTrades(trades: Trade[], tradesFile: string): void {
  try {
    writeFileSync(resolve(tradesFile), JSON.stringify(trades, null, 2), 'utf8');
    console.info(`💾 Saved ${trades.length} trades to ${tradesFile}`);
  } catch (e: any) {
    console.error('Failed to save trades file:', e?.message ?? e);
  }
}

/**
 * Loads the current active trade
 */
export function loadCurrentTrade(currentTradeFile: string): Trade | null {
  try {
    if (existsSync(resolve(currentTradeFile))) {
      const raw = readFileSync(resolve(currentTradeFile), 'utf8');
      return JSON.parse(raw || 'null');
    }
  } catch (e: any) {
    console.warn('Failed to load current trade file:', e?.message ?? e);
  }
  return null;
}

/**
 * Saves the current active trade
 */
export function saveCurrentTrade(trade: Trade | null, currentTradeFile: string): void {
  try {
    if (trade === null) {
      if (existsSync(resolve(currentTradeFile))) {
        unlinkSync(resolve(currentTradeFile));
        console.info('🗑️  Cleared current trade file');
      }
    } else {
      writeFileSync(
        resolve(currentTradeFile),
        JSON.stringify(trade, null, 2),
        'utf8'
      );
      console.info(`💾 Saved current trade to ${currentTradeFile}`);
    }
  } catch (e: any) {
    console.error('Failed to save current trade file:', e?.message ?? e);
  }
}

/**
 * Checks if there's an active trade today
 */
export function hasActiveTradeToday(date: string, currentTradeFile: string): boolean {
  const currentTrade = loadCurrentTrade(currentTradeFile);
  if (currentTrade && currentTrade.date === date && currentTrade.status === 'OPEN') {
    console.info(
      `⚠️  Active trade already exists for ${date}: ${currentTrade.tradingsymbol}`
    );
    return true;
  }
  return false;
}

/**
 * Calculate P/L Summary
 */
export function getPnLSummary(tradesFile: string): PnLSummary {
  const allTrades = loadAllTrades(tradesFile);
  const closedTrades = allTrades.filter(t => t.status === 'CLOSED' && t.pnl != null);
  
  const today = dateOnlyString(new Date());
  const todayTrades = closedTrades.filter(t => t.date === today);
  
  // Overall stats
  const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winners = closedTrades.filter(t => (t.pnl || 0) > 0).length;
  const losers = closedTrades.filter(t => (t.pnl || 0) <= 0).length;
  const winRate = closedTrades.length > 0 ? (winners / closedTrades.length) * 100 : 0;
  
  // Today's stats
  const todayPnL = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const todayWinners = todayTrades.filter(t => (t.pnl || 0) > 0).length;
  const todayLosers = todayTrades.filter(t => (t.pnl || 0) <= 0).length;
  const todayWinRate = todayTrades.length > 0 ? (todayWinners / todayTrades.length) * 100 : 0;
  
  return {
    totalPnL,
    todayPnL,
    totalTrades: closedTrades.length,
    todayTrades: todayTrades.length,
    winners,
    losers,
    winRate,
    todayWinners,
    todayLosers,
    todayWinRate
  };
}

/**
 * Print colorful P/L summary to terminal
 */
export function printPnLSummary(tradesFile: string): void {
  const summary = getPnLSummary(tradesFile);
  
  const divider = c.gray('─'.repeat(50));
  const doubleDivider = c.gray('═'.repeat(50));
  
  console.log('\n' + doubleDivider);
  console.log(c.bright('                  📊 P/L SUMMARY'));
  console.log(doubleDivider);
  
  // Today's P/L
  console.log(divider);
  console.log(c.cyan('  TODAY'));
  console.log(divider);
  console.log(`  Trades:    ${c.bright(summary.todayTrades.toString())}`);
  console.log(`  Winners:   ${c.green(summary.todayWinners.toString())}  |  Losers: ${c.red(summary.todayLosers.toString())}`);
  console.log(`  Win Rate:  ${summary.todayWinRate >= 50 ? c.green(summary.todayWinRate.toFixed(1) + '%') : c.red(summary.todayWinRate.toFixed(1) + '%')}`);
  console.log(`  P/L:       ${c.pnl(summary.todayPnL)}`);
  
  // Overall P/L
  console.log(divider);
  console.log(c.cyan('  OVERALL'));
  console.log(divider);
  console.log(`  Trades:    ${c.bright(summary.totalTrades.toString())}`);
  console.log(`  Winners:   ${c.green(summary.winners.toString())}  |  Losers: ${c.red(summary.losers.toString())}`);
  console.log(`  Win Rate:  ${summary.winRate >= 50 ? c.green(summary.winRate.toFixed(1) + '%') : c.red(summary.winRate.toFixed(1) + '%')}`);
  console.log(`  P/L:       ${c.pnl(summary.totalPnL)}`);
  
  console.log(doubleDivider + '\n');
}

/**
 * Records a trade entry
 */
export function recordTradeEntry(
  signal: string,
  tradingsymbol: string,
  strike: number,
  optionType: string,
  quantity: number,
  entryPrice: number,
  stopLoss: number,
  target: number,
  config: TradeConfig,
  orderId?: string,
  tradeReason?: TradeReason,
  paperTrade: boolean = false
): Trade {
  const now = new Date();
  const trade: Trade = {
    date: dateOnlyString(now),
    time: now.toTimeString().slice(0, 8),
    signal,
    tradingsymbol,
    strike,
    optionType,
    quantity,
    entryPrice,
    stopLoss,
    initialStopLoss: stopLoss,
    target,
    initialTarget: target,
    orderId: orderId ?? undefined,
    status: 'OPEN',
    ...(tradeReason ? { tradeReason } : {}),
    levelModifications: [],
    ...(paperTrade ? { paperTrade: true } : {})
  };

  // Save as current trade
  saveCurrentTrade(trade, config.currentTradeFile);

  // Add to all trades history
  const allTrades = loadAllTrades(config.tradesFile);
  allTrades.push(trade);
  saveAllTrades(allTrades, config.tradesFile);

  // Colorful entry log
  const signalColor = signal === 'BULL' ? c.green(signal) : c.red(signal);
  const paperTag = paperTrade ? c.yellow(' [PAPER]') : '';
  console.log('\n' + c.gray('─'.repeat(50)));
  console.log(`  📈 ${c.bright('NEW TRADE OPENED')}${paperTag}`);
  console.log(c.gray('─'.repeat(50)));
  console.log(`  Signal:     ${signalColor}`);
  console.log(`  Symbol:     ${c.bright(tradingsymbol)}`);
  console.log(`  Entry:      ${c.cyan('₹' + entryPrice.toFixed(2))}`);
  console.log(`  Quantity:   ${c.bright(quantity.toString())}`);
  console.log(`  Stop Loss:  ${c.red('₹' + stopLoss.toFixed(2))}`);
  console.log(`  Target:     ${c.green('₹' + target.toFixed(2))}`);
  if (paperTrade) {
    console.log(`  Mode:       ${c.yellow('PAPER TRADE (simulated)')}`);
  }
  console.log(c.gray('─'.repeat(50)) + '\n');

  return trade;
}

/**
 * Records a trade exit with colorful P/L summary
 */
export function recordTradeExit(
  exitPrice: number,
  exitReason: 'SL' | 'TARGET' | 'EOD' | 'MANUAL',
  config: TradeConfig
): void {
  const currentTrade = loadCurrentTrade(config.currentTradeFile);
  if (!currentTrade) {
    console.warn('⚠️  No current trade to exit');
    return;
  }
  
  const now = new Date();
  currentTrade.exitPrice = exitPrice;
  currentTrade.exitTime = now.toTimeString().slice(0, 8);
  currentTrade.exitReason = exitReason;
  currentTrade.status = 'CLOSED';
  currentTrade.pnl = (exitPrice - currentTrade.entryPrice) * currentTrade.quantity;
  
  // Update in all trades history
  const allTrades = loadAllTrades(config.tradesFile);
  const index = allTrades.findIndex(
    t =>
      t.date === currentTrade.date &&
      t.time === currentTrade.time &&
      t.tradingsymbol === currentTrade.tradingsymbol
  );
  
  if (index >= 0) {
    allTrades[index] = currentTrade;
    saveAllTrades(allTrades, config.tradesFile);
  }
  
  // Clear current trade
  saveCurrentTrade(null, config.currentTradeFile);
  
  // Colorful exit log
  const pnl = currentTrade.pnl || 0;
  const perUnitPnL = exitPrice - currentTrade.entryPrice;
  const isProfit = pnl >= 0;
  
  const reasonEmoji = exitReason === 'TARGET' ? '🎯' : exitReason === 'SL' ? '🛑' : '🔔';
  const reasonColor = exitReason === 'TARGET' ? c.green(exitReason) : exitReason === 'SL' ? c.red(exitReason) : c.yellow(exitReason);
  
  console.log('\n' + c.gray('═'.repeat(50)));
  console.log(`  ${reasonEmoji} ${c.bright('TRADE CLOSED')} - ${reasonColor}`);
  console.log(c.gray('═'.repeat(50)));
  console.log(`  Symbol:     ${c.bright(currentTrade.tradingsymbol)}`);
  console.log(`  Entry:      ${c.cyan('₹' + currentTrade.entryPrice.toFixed(2))}`);
  console.log(`  Exit:       ${c.cyan('₹' + exitPrice.toFixed(2))}`);
  console.log(`  Quantity:   ${c.bright(currentTrade.quantity.toString())}`);
  console.log(c.gray('─'.repeat(50)));
  console.log(`  Per Unit:   ${c.pnl(perUnitPnL)}`);
  console.log(`  ${c.bright('TRADE P/L:')}  ${c.pnl(pnl)}`);
  console.log(c.gray('═'.repeat(50)));
  
  // Print overall summary
  printPnLSummary(config.tradesFile);
}

/**
 * Gets today's closed trades
 */
export function getTodayClosedTrades(date: string, tradesFile: string): Trade[] {
  const allTrades = loadAllTrades(tradesFile);
  return allTrades.filter(t => t.date === date && t.status === 'CLOSED');
}

/**
 * Cleans up stale OPEN trades from a previous day.
 *
 * When the algo restarts (e.g. cloud redeploy, daily reboot), there may be
 * a current_trade.json left over from a previous trading session. If that
 * trade's date is NOT today, it's stale — the position was either auto-squared
 * off by the broker at EOD, manually closed, or the option expired. Leaving it
 * as OPEN blocks the engine from taking new trades.
 *
 * This function:
 * 1. Loads current_trade.json
 * 2. If the trade date != today → marks it CLOSED in trades.json and removes
 *    current_trade.json
 * 3. If the trade date == today → leaves it alone (resumeOpenTrade handles it)
 *
 * Should be called early in the startup flow, BEFORE resumeOpenTrade().
 */
export function cleanupStaleTrades(config: TradeConfig): void {
  const currentTrade = loadCurrentTrade(config.currentTradeFile);

  if (!currentTrade) {
    return; // No current trade file — nothing to clean
  }

  if (currentTrade.status !== 'OPEN') {
    // Trade is already closed but file wasn't cleaned up — just remove it
    console.info(
      `🧹 Found non-OPEN trade in current_trade.json (status=${currentTrade.status}) — cleaning up`
    );
    saveCurrentTrade(null, config.currentTradeFile);
    return;
  }

  const todayStr = dateOnlyString(new Date());

  if (currentTrade.date === todayStr) {
    // Trade is from today — don't touch it; resumeOpenTrade() will handle it
    console.info(
      `📋 Current trade is from today (${currentTrade.tradingsymbol}) — leaving for resumeOpenTrade()`
    );
    return;
  }

  // ── Stale trade detected ──
  console.warn(
    `\n⚠️  STALE TRADE DETECTED — cleaning up\n` +
    `   Symbol:     ${currentTrade.tradingsymbol}\n` +
    `   Trade Date: ${currentTrade.date}\n` +
    `   Today:      ${todayStr}\n` +
    `   Status:     OPEN → will be marked CLOSED\n`
  );

  // Mark the trade as closed in the history file
  const allTrades = loadAllTrades(config.tradesFile);
  const matchIdx = allTrades.findIndex(
    t =>
      t.date === currentTrade.date &&
      t.time === currentTrade.time &&
      t.tradingsymbol === currentTrade.tradingsymbol &&
      t.status === 'OPEN'
  );

  const now = new Date();
  const closedTrade: Trade = {
    ...currentTrade,
    status: 'CLOSED',
    exitReason: 'EOD',
    exitTime: '15:30:00', // Assume EOD auto-square-off time
    exitPrice: currentTrade.entryPrice, // Unknown actual exit — use entry as placeholder
    pnl: 0 // Unknown — set to 0 since we don't know the actual exit price
  };

  if (matchIdx >= 0) {
    allTrades[matchIdx] = closedTrade;
  } else {
    // The OPEN entry might not exist in trades.json (edge case), add it
    allTrades.push(closedTrade);
  }

  saveAllTrades(allTrades, config.tradesFile);

  // Remove current_trade.json so the engine can take new trades
  saveCurrentTrade(null, config.currentTradeFile);

  console.info(
    `✅ Stale trade ${currentTrade.tradingsymbol} marked CLOSED (EOD) and cleared from current_trade.json`
  );
}

/**
 * Utility: Get date-only string (YYYY-MM-DD)
 */
function dateOnlyString(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}