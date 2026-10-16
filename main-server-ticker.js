/**
 * Main Application Entry Point (Ticker-Based)
 * Uses WebSocket ticker for real-time instrument monitoring
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { KiteConnect, KiteTicker } = require('kiteconnect');
const fs = require('fs');
const path = require('path');
const util = require('util');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const APP_TOKEN = process.env.LOGS_TOKEN || '';
const APP_COOKIE = 'app_token';

// --- Whole-app access gate ---
// Single shared secret (LOGS_TOKEN in .env) protects the dashboard, all API
// routes, and the live log viewer, since this server is reachable on the
// public internet. Visiting any URL once with ?token=<secret> sets an
// HttpOnly cookie so the existing frontend's fetch() calls keep working
// without needing to be modified to carry the token themselves.
function requireAppAccess(req, res, next) {
  if (!APP_TOKEN) {
    return res.status(503).send('Set LOGS_TOKEN in .env to enable access');
  }
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(p => p.trim().split('=')).filter(p => p[0])
  );
  if (cookies[APP_COOKIE] === APP_TOKEN) {
    return next();
  }
  if (req.query.token === APP_TOKEN) {
    res.setHeader('Set-Cookie', `${APP_COOKIE}=${APP_TOKEN}; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}; Path=/`);
    return next();
  }
  return res.status(401).send('Unauthorized — append ?token=<LOGS_TOKEN> to the URL once');
}

app.use(requireAppAccess);
app.use(express.static(path.join(__dirname, 'public')));

// --- In-process live log capture (backs /logs and /logs/stream) ---
const LOG_BUFFER_SIZE = 1000;
const logBuffer = [];
const logClients = new Set();

function broadcastLog(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) {
    res.write(payload);
  }
}

function captureLog(level) {
  const original = console[level].bind(console);
  return (...args) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      text: util.format(...args)
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    broadcastLog(entry);
    original(...args);
  };
}

console.log = captureLog('log');
console.info = captureLog('info');
console.warn = captureLog('warn');
console.error = captureLog('error');

const kc = new KiteConnect({ api_key: API_KEY });

// Global state
let accessToken = null;
let tradingEngine = null;
let tickerManager = null;
let activeMonitor = null;

/**
 * Resume monitoring an open trade after server restart.
 * Delegates to tradingEngine.resumeTrade(), which attaches to the engine's
 * already-connected ticker instead of opening a second WebSocket connection
 * — Kite only allows one live connection per access token, so a second
 * connect attempt hangs/times out and can disrupt the first.
 */
async function resumeOpenTrade() {
  try {
    // ── Clean up stale trades from previous days ──
    // Must run BEFORE we try to resume any open trade.
    // If current_trade.json is from a previous date, it gets marked CLOSED
    // and removed so it doesn't block today's trading session.
    try {
      const { cleanupStaleTrades } = require('./dist/modules/trades/persistence');
      cleanupStaleTrades({
        tradesFile: TRADING_CONFIG.tradesFile,
        currentTradeFile: TRADING_CONFIG.currentTradeFile
      });
    } catch (e) {
      console.warn('⚠️ Could not run stale trade cleanup:', e?.message || e);
    }

    const currentTradeFile = TRADING_CONFIG.currentTradeFile;
    const p = path.resolve(currentTradeFile);

    if (!fs.existsSync(p)) {
      console.log('✅ No open trade to resume');
      return;
    }

    const trade = JSON.parse(fs.readFileSync(p, 'utf8'));

    if (!trade || trade.status !== 'OPEN') {
      console.log('✅ No open trade to resume');
      return;
    }

    if (!tradingEngine) {
      console.error('❌ Cannot resume trade: trading engine not started yet');
      return;
    }

    // Verify the position still actually exists at the broker before resuming
    // monitoring — local state can go stale if the position was squared off
    // (manually, by auto square-off, or an SL/target fill) while the bot was
    // down. Resuming monitoring on a phantom position risks the exit logic
    // later placing a SELL order against a position that no longer exists.
    // Paper trades have no broker-side state, so this only applies live.
    if (!trade.paperTrade) {
      try {
        const positions = await kc.getPositions();
        const net = (positions?.net || []).find(
          (pos) => pos.tradingsymbol === trade.tradingsymbol
        );

        if (!net || net.quantity === 0) {
          console.warn(
            `⚠️ ${trade.tradingsymbol} is OPEN locally but no matching position was found at Kite ` +
            `— it was likely closed elsewhere while the bot was down. Reconciling as closed instead of resuming.`
          );

          const { recordTradeExit } = require('./dist/modules/trades/persistence');
          const { getOptionLTP } = require('./dist/modules/orders/executor');
          let approxExit = trade.entryPrice;
          try {
            const ltp = await getOptionLTP(kc, trade.tradingsymbol);
            if (ltp) approxExit = ltp;
          } catch (e) {
            // Fall back to entry price if LTP fetch also fails
          }

          recordTradeExit(approxExit, 'MANUAL', {
            tradesFile: TRADING_CONFIG.tradesFile,
            currentTradeFile: TRADING_CONFIG.currentTradeFile
          });
          console.warn(
            `⚠️ Marked ${trade.tradingsymbol} CLOSED with approximate exit ₹${approxExit.toFixed(2)} ` +
            `(actual fill price unknown — reconciled from broker state, not a real recorded exit)`
          );
          return;
        }

        console.log(`✅ Verified ${trade.tradingsymbol} position exists at Kite (qty=${net.quantity}) — resuming monitoring`);
      } catch (e) {
        // If we can't reach the broker to verify, err on the side of resuming
        // monitoring anyway — an unmonitored live position (no SL/target
        // safety net) is a bigger risk than a monitor running against a
        // position that turns out to already be closed.
        console.warn(`⚠️ Could not verify position at Kite (${e?.message || e}) — resuming monitoring without verification`);
      }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('  🔄 RESUMING OPEN TRADE');
    console.log('═'.repeat(50));
    console.log(`  Symbol:     ${trade.tradingsymbol}`);
    console.log(`  Signal:     ${trade.signal}`);
    console.log(`  Entry:      ₹${trade.entryPrice.toFixed(2)}`);
    console.log(`  Stop Loss:  ₹${trade.stopLoss.toFixed(2)}`);
    console.log(`  Target:     ₹${trade.target.toFixed(2)}`);
    console.log(`  Quantity:   ${trade.quantity}`);
    console.log('═'.repeat(50) + '\n');

    const resumed = tradingEngine.resumeTrade(trade);
    if (!resumed) {
      console.error('❌ Failed to resume monitoring for', trade.tradingsymbol);
    }
  } catch (err) {
    console.error('❌ Error resuming trade:', err?.message || err);
  }
}

// Trading configuration
const TRADING_CONFIG = {
  // Instrument settings
  instrumentsFile: process.env.INSTRUMENTS_CSV || 'instruments.csv',
  indexSymbol: 'NIFTY 50',
  
  // Box settings
  boxStart: process.env.BOX_START || '09:15',
  boxEnd: process.env.BOX_END || '09:30',
  boxJsonFile: process.env.BOX_JSON_FILE || 'box.json',
  boxBreakMargin: Number(process.env.BOX_BREAK_MARGIN || '0'),
  
  // Trading settings
  interval: process.env.INTERVAL || '5minute',
  lotMultiplier: Number(process.env.LOT_MULTIPLIER || '1'),
  roundStrikeTo: Number(process.env.ROUND_STRIKE_TO || '50'),
  
  // Risk management
  slBuffer: Number(process.env.SL_BUFFER || '20'),
  targetMin: Number(process.env.TARGET_MIN || '40'),
  trailingStopLoss: {
    profitThreshold: Number(process.env.TRAILING_SL_PROFIT_THRESHOLD || '20'),
    newSLDistance: Number(process.env.TRAILING_SL_NEW_DISTANCE || '10')
  },
  
  // Timing
  checkEverySeconds: Number(process.env.CHECK_EVERY_SECONDS || '10'),
  marketCloseTime: process.env.MARKET_CLOSE_TIME || '15:30',
  
  // Files
  tradesFile: process.env.TRADES_FILE || 'trades.json',
  currentTradeFile: process.env.CURRENT_TRADE_FILE || 'current_trade.json',
  
  // Order settings
  exchange: 'NFO',
  product: 'NRML',
  validity: 'DAY',
  variety: 'regular',
  
  // Ticker settings (will be populated after login)
  apiKey: API_KEY,
  accessToken: null
};

// Login route
app.get('/login', (req, res) => {
  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(API_KEY)}`;
  return res.redirect(loginUrl);
});

// Callback route
app.get('/callback', async (req, res) => {
  try {
    const { request_token } = req.query;
    console.log('📥 Received request_token:', request_token);
    
    if (!request_token) {
      return res.status(400).send('Missing request_token');
    }
    
    const response = await kc.generateSession(request_token, API_SECRET);
    accessToken = response.access_token;
    kc.setAccessToken(accessToken);
    
    console.log('✅ Session generated:', response);
    
    // Update config with access token
    TRADING_CONFIG.accessToken = accessToken;

    // Stop any previously running engine before starting a new one. Repeat
    // logins (daily token refresh, or someone else logging into the same
    // account from another location) must not leave two engines running
    // duplicate candle/signal loops against the same ticker — that would
    // double-place trades. Any open position is picked back up below via
    // resumeOpenTrade() once the fresh engine/ticker is up.
    if (tradingEngine) {
      console.log('🔁 Existing trading engine found — stopping it before starting a fresh session');
      try {
        tradingEngine.stop();
      } catch (e) {
        console.warn('⚠️ Error stopping previous engine:', e?.message || e);
      }
      tradingEngine = null;
    }

    // Start ticker-based trading engine
    try {
      // Try to load the compiled version first
      if (fs.existsSync('./dist/ticker-trading-engine.js')) {
        const { startTickerTradingEngine } = require('./dist/ticker-trading-engine');
        tradingEngine = await startTickerTradingEngine(kc, TRADING_CONFIG);
        console.log('✅ Ticker-based trading engine started');

        // Setup event listeners
        tradingEngine.on('price', (price, tick) => {
          // Log price updates periodically
          if (Math.random() < 0.01) { // 1% of ticks
            console.log(`📊 Index: ₹${price.toFixed(2)}`);
          }
        });

        tradingEngine.on('stopped', () => {
          console.log('⏹️ Trading engine stopped');
        });

        // Check for open trade to resume, now that the engine's ticker is live
        await resumeOpenTrade();
      } else {
        // Fallback to polling-based engine
        console.log('⚠️ Ticker engine not compiled, using polling fallback');
        
        if (fs.existsSync('./dist/trading-engine.js')) {
          const { startTradingEngine } = require('./dist/trading-engine');
          startTradingEngine(kc, TRADING_CONFIG)
            .then(() => console.log('✅ Polling-based trading engine started'))
            .catch(e => console.error('❌ Trading engine error:', e));
        } else {
          // Try TypeScript source with tsx
          const { spawn } = require('child_process');
          const child = spawn('npx', ['tsx', 'ticker-trading-engine.ts'], {
            env: Object.assign({}, process.env, {
              API_KEY: API_KEY,
              ACCESS_TOKEN: accessToken
            }),
            stdio: 'inherit'
          });
          child.on('error', e => console.error('❌ Failed to spawn trading engine:', e));
        }
      }
    } catch (e) {
      console.error('❌ Error starting trading engine:', e);
    }
    
    res.send(`
      <html>
        <head>
          <title>Trading Engine Started</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #1a1a2e; color: #eee; }
            .container { max-width: 800px; margin: 0 auto; }
            h1 { color: #00d9ff; }
            .status { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
            .success { border-left: 4px solid #00ff88; }
            a { color: #00d9ff; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Login Successful!</h1>
            <div class="status success">
              <h2>🚀 Ticker-Based Trading Engine Started</h2>
              <p>WebSocket streaming is now active for real-time price monitoring.</p>
              <p>Mode: <strong>WebSocket Ticker</strong> (No polling)</p>
            </div>
            <h3>Quick Links:</h3>
            <ul>
              <li><a href="/status">Engine Status</a></li>
              <li><a href="/box">Today's Box</a></li>
              <li><a href="/trades/today">Today's Trades</a></li>
              <li><a href="/current-trade">Current Trade</a></li>
              <li><a href="/ticker/status">Ticker Status</a></li>
            </ul>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Error generating session:', err);
    if (!res.headersSent) {
      res.status(500).send('Error generating session');
    }
  }
});

// API Routes

// Engine status
app.get('/status', (req, res) => {
  const status = {
    engineRunning: tradingEngine?.isActive() ?? false,
    tickerConnected: tickerManager?.isActive() ?? false,
    accessTokenSet: !!accessToken,
    config: {
      indexSymbol: TRADING_CONFIG.indexSymbol,
      interval: TRADING_CONFIG.interval,
      marketCloseTime: TRADING_CONFIG.marketCloseTime,
      trailingStopLoss: TRADING_CONFIG.trailingStopLoss
    }
  };
  
  if (tradingEngine) {
    status.engineState = tradingEngine.getState();
  }
  
  res.json(status);
});

// Ticker status
app.get('/ticker/status', (req, res) => {
  // Check if trading engine has ticker info
  if (tradingEngine && tradingEngine.getTickerStatus) {
    return res.json(tradingEngine.getTickerStatus());
  }

  if (tradingEngine && tradingEngine.isActive()) {
    return res.json({
      connected: true,
      message: 'Trading engine running with ticker',
      engineActive: true
    });
  }

  if (!accessToken) {
    return res.json({
      connected: false,
      subscriptions: 0,
      message: 'Not logged in - visit /login first'
    });
  }

  if (!tickerManager) {
    return res.json({
      connected: false,
      subscriptions: 0,
      message: 'Ticker not initialized - trading engine may be starting'
    });
  }

  res.json({
    connected: tickerManager.isActive(),
    subscriptions: tickerManager.getSubscriptionCount(),
    subscribedTokens: tickerManager.getSubscribedTokens()
  });
});

// Get LTP via ticker
app.get('/ticker/ltp/:symbol', (req, res) => {
  const { symbol } = req.params;
  
  if (!tickerManager) {
    return res.status(503).json({ error: 'Ticker not initialized' });
  }
  
  const price = tickerManager.getLatestPriceBySymbol(symbol);
  
  if (price === null) {
    return res.status(404).json({ error: 'Price not available', symbol });
  }
  
  res.json({ symbol, ltp: price, source: 'ticker' });
});

// Holdings route
app.get('/holdings', async (req, res) => {
  kc.getHoldings()
    .then(holdings => res.json(holdings))
    .catch(err => {
      console.error('Error fetching holdings:', err);
      res.status(500).json({ error: 'Failed to fetch holdings' });
    });
});

// Box route
app.get('/box', (req, res) => {
  const boxFile = TRADING_CONFIG.boxJsonFile;
  const p = path.resolve(boxFile);
  if (fs.existsSync(p)) {
    res.sendFile(p);
  } else {
    res.status(404).json({ error: 'box file not found' });
  }
});

// Candles route (still uses API for historical data)
app.get('/candles', async (req, res) => {
  try {
    if (!accessToken) {
      return res.status(503).json({ error: 'Please login first at /login' });
    }
    if (!kc || typeof kc.getHistoricalData !== 'function') {
      return res.status(503).json({ error: 'kite client not ready' });
    }

    const token = '256265'; // NIFTY 50 token
    const fromDt = new Date(Date.now() - 1000 * 60 * 150);
    const toDt = new Date();

    const candles = await kc.getHistoricalData(token, '5minute', fromDt, toDt);
    if (!Array.isArray(candles) || candles.length === 0) {
      return res.json({ candles: [] });
    }

    const formatted = candles.map(c => ({
      date: c[0] || c.date || c.time,
      open: c[1] || c.open,
      high: c[2] || c.high,
      low: c[3] || c.low,
      close: c[4] || c.close,
    }));

    res.json({ candles: formatted });
  } catch (err) {
    console.error('Candles endpoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Intraday candles route (from 9:15 to current)
app.get('/candles/intraday', async (req, res) => {
  try {
    if (!accessToken) {
      return res.status(503).json({ error: 'Please login first at /login' });
    }
    if (!kc || typeof kc.getHistoricalData !== 'function') {
      return res.status(503).json({ error: 'kite client not ready' });
    }

    const token = '256265'; // NIFTY 50 token
    const now = new Date();

    // Create today's 9:15 AM timestamp
    const marketOpen = new Date(now);
    marketOpen.setHours(9, 15, 0, 0);

    // Check if market is open yet
    if (now < marketOpen) {
      return res.json({ message: 'Market not yet open', candles: [] });
    }

    const candles = await kc.getHistoricalData(token, '5minute', marketOpen, now);
    if (!Array.isArray(candles) || candles.length === 0) {
      return res.json({ candles: [] });
    }

    const formatted = candles.map(c => ({
      date: c[0] || c.date || c.time,
      open: c[1] || c.open,
      high: c[2] || c.high,
      low: c[3] || c.low,
      close: c[4] || c.close,
    }));

    res.json({ candles: formatted });
  } catch (err) {
    console.error('Intraday candles endpoint error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trades routes
app.get('/trades', (req, res) => {
  try {
    const tradesFile = TRADING_CONFIG.tradesFile;
    const p = path.resolve(tradesFile);
    if (fs.existsSync(p)) {
      const trades = JSON.parse(fs.readFileSync(p, 'utf8'));
      res.json({ trades, count: trades.length });
    } else {
      res.json({ trades: [], count: 0, message: 'No trades file found' });
    }
  } catch (err) {
    console.error('Error reading trades:', err);
    res.status(500).json({ error: 'Failed to read trades' });
  }
});

app.get('/current-trade', (req, res) => {
  try {
    const currentTradeFile = TRADING_CONFIG.currentTradeFile;
    const p = path.resolve(currentTradeFile);
    if (fs.existsSync(p)) {
      const trade = JSON.parse(fs.readFileSync(p, 'utf8'));
      res.json({ trade });
    } else {
      res.json({ trade: null, message: 'No active trade' });
    }
  } catch (err) {
    console.error('Error reading current trade:', err);
    res.status(500).json({ error: 'Failed to read current trade' });
  }
});

app.get('/trades/today', (req, res) => {
  try {
    const tradesFile = TRADING_CONFIG.tradesFile;
    const p = path.resolve(tradesFile);
    if (fs.existsSync(p)) {
      const allTrades = JSON.parse(fs.readFileSync(p, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = allTrades.filter(t => t.date === today);
      res.json({ trades: todayTrades, count: todayTrades.length, date: today });
    } else {
      res.json({ trades: [], count: 0, message: 'No trades file found' });
    }
  } catch (err) {
    console.error('Error reading today\'s trades:', err);
    res.status(500).json({ error: 'Failed to read trades' });
  }
});

// Stop engine route
app.post('/engine/stop', (req, res) => {
  if (tradingEngine && tradingEngine.isActive()) {
    tradingEngine.stop();
    res.json({ success: true, message: 'Trading engine stopped' });
  } else {
    res.json({ success: false, message: 'Trading engine not running' });
  }
});

// Resume trade route (manual trigger)
app.post('/trade/resume', async (req, res) => {
  try {
    if (!accessToken) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    if (!tradingEngine) {
      return res.status(503).json({ error: 'Trading engine not running yet' });
    }
    await resumeOpenTrade();
    res.json({ success: true, message: 'Resume initiated - check logs' });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Resume failed' });
  }
});

// Update trade levels (SL and/or Target) from the UI input boxes
app.post('/trade/update-levels', (req, res) => {
  try {
    const { stopLoss, target } = req.body;

    // At least one value must be provided
    if (stopLoss === undefined && target === undefined) {
      return res.status(400).json({ error: 'Provide stopLoss and/or target' });
    }

    // Validate provided values
    if (stopLoss !== undefined && (typeof stopLoss !== 'number' || stopLoss <= 0)) {
      return res.status(400).json({ error: 'Invalid stopLoss value' });
    }
    if (target !== undefined && (typeof target !== 'number' || target <= 0)) {
      return res.status(400).json({ error: 'Invalid target value' });
    }

    // Load current trade from file
    const currentTradeFile = TRADING_CONFIG.currentTradeFile;
    const p = path.resolve(currentTradeFile);

    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'No active trade found' });
    }

    const trade = JSON.parse(fs.readFileSync(p, 'utf8'));

    if (!trade || trade.status !== 'OPEN') {
      return res.status(404).json({ error: 'No open trade to update' });
    }

    const now = new Date().toISOString();

    // Apply stopLoss update
    if (stopLoss !== undefined && stopLoss !== trade.stopLoss) {
      const mod = {
        timestamp: now,
        field: 'stopLoss',
        oldValue: trade.stopLoss,
        newValue: stopLoss,
        source: 'MANUAL'
      };
      trade.stopLoss = stopLoss;
      if (!trade.levelModifications) trade.levelModifications = [];
      trade.levelModifications.push(mod);
      console.info(`🔄 Stop Loss updated via UI: ₹${mod.oldValue.toFixed(2)} → ₹${stopLoss.toFixed(2)}`);
    }

    // Apply target update
    if (target !== undefined && target !== trade.target) {
      const mod = {
        timestamp: now,
        field: 'target',
        oldValue: trade.target,
        newValue: target,
        source: 'MANUAL'
      };
      trade.target = target;
      if (!trade.levelModifications) trade.levelModifications = [];
      trade.levelModifications.push(mod);
      console.info(`🔄 Target updated via UI: ₹${mod.oldValue.toFixed(2)} → ₹${target.toFixed(2)}`);
    }

    // Persist the updated trade back to file
    fs.writeFileSync(p, JSON.stringify(trade, null, 2));

    // Also update the in-memory monitor so live exit logic picks up the new levels
    if (tradingEngine && tradingEngine.getActiveMonitor) {
      const monitor = tradingEngine.getActiveMonitor();
      if (monitor) {
        monitor.updateLevels(
          stopLoss !== undefined ? stopLoss : undefined,
          target !== undefined ? target : undefined
        );
      }
    }

    // Broadcast updated trade via WebSocket if available
    if (typeof global !== 'undefined' && global.wsBroadcast) {
      global.wsBroadcast('trade_update', { type: 'LEVELS_MODIFIED', trade });
    }

    res.json({ success: true, trade });
  } catch (err) {
    console.error('❌ Error updating trade levels:', err);
    res.status(500).json({ error: err?.message || 'Failed to update levels' });
  }
});

// Live log viewer UI
app.get('/logs', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'logs.html'));
});

// Live log SSE stream
app.get('/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), level: 'info', text: '--- connected to live log stream ---' })}\n\n`);
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  logClients.add(res);
  req.on('close', () => {
    logClients.delete(res);
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`🔑 Visit http://localhost:${PORT}/login to start`);
  console.log(`📊 Mode: Ticker-Based (WebSocket Streaming)`);
});

// Error handlers
process.on('uncaughtException', err => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  if (tradingEngine) {
    tradingEngine.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⏹️ Shutting down...');
  if (tradingEngine) {
    tradingEngine.stop();
  }
  process.exit(0);
});