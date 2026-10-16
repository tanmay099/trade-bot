# NIFTY Trading Bot - Modular Architecture ✅

**Status:** All TypeScript errors fixed! ✅

## 🎯 Overview

Professional modular trading system for NIFTY options with box breakout strategy. Fully type-safe TypeScript implementation with comprehensive error handling and trade management.

## 📦 Project Structure

```
trading-bot/
├── modules/
│   ├── instruments/
│   │   └── parser.ts          # Instrument data handling
│   ├── box/
│   │   └── calculator.ts      # Box computation & persistence
│   ├── signals/
│   │   └── detector.ts        # Signal detection logic
│   ├── orders/
│   │   └── executor.ts        # Order placement & execution
│   ├── monitor/
│   │   └── position.ts        # Position monitoring & exits
│   └── trades/
│       └── persistence.ts     # Trade history management
├── trading-engine.ts          # Main orchestration engine
├── main-server.js             # Express API server
├── types.d.ts                 # TypeScript type declarations
├── tsconfig.json              # TypeScript configuration
└── package.json               # Dependencies
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Environment File

Create a `.env` file in the project root:

```env
# Kite API Credentials
API_KEY=your_api_key
API_SECRET=your_api_secret

# Files
INSTRUMENTS_CSV=instruments.csv

# Box Settings
BOX_START=09:15
BOX_END=09:30
BOX_JSON_FILE=box.json
BOX_BREAK_MARGIN=0

# Trading Settings
INTERVAL=5minute
LOT_MULTIPLIER=2
ROUND_STRIKE_TO=50

# Risk Management
SL_BUFFER=20
TARGET_MIN=35
TARGET_MAX=40

# Timing
CHECK_EVERY_SECONDS=10
MARKET_CLOSE_TIME=15:30

# Trade Files
TRADES_FILE=trades.json
CURRENT_TRADE_FILE=current_trade.json

# Paper Trading (optional)
PAPER_TRADING=false
```

### 3. Download Instruments CSV

Download the instruments CSV from Kite Connect and save as `instruments.csv`:
```bash
curl -o instruments.csv https://api.kite.trade/instruments
```

### 4. Compile TypeScript

```bash
npm run build
```

### 5. Start the Server

```bash
npm start
```

### 6. Login & Trade

1. Visit `http://localhost:3000/login`
2. Complete Kite authentication
3. System will automatically start trading

## 📖 Module Documentation

### 1. Instruments Parser (`modules/instruments/parser.ts`)

Handles CSV parsing and instrument search.

```typescript
import { loadInstruments, findIndexRow, findOptionInstrument } from './modules/instruments/parser';

// Load instruments
const instruments = loadInstruments('instruments.csv');

// Find NIFTY index
const nifty = findIndexRow(instruments, 'NIFTY 50');

// Find option contract
const option = findOptionInstrument(
  instruments,
  'NIFTY',
  expiryDate,
  23500,
  'CE'
);
```

**Exports:**
- `loadInstruments(filePath)` - Load instruments from CSV
- `findIndexRow(instruments, symbol)` - Find index instrument
- `findOptionInstrument(...)` - Find specific option
- `nearestWeeklyExpiry()` - Get next Tuesday
- `roundStrike(price, roundTo)` - Round strike price

### 2. Box Calculator (`modules/box/calculator.ts`)

Computes and persists box high/low levels.

```typescript
import { loadBoxFromFile, computeBoxForToday } from './modules/box/calculator';

// Load saved box
const box = loadBoxFromFile('box.json');

// Compute new box
const newBox = await computeBoxForToday(kite, tokenId, {
  boxStart: '09:15',
  boxEnd: '09:30',
  interval: '5minute',
  boxJsonFile: 'box.json',
  boxBreakMargin: 0
});
```

**Exports:**
- `loadBoxFromFile(file)` - Load persisted box data
- `computeBoxForToday(kite, token, config)` - Calculate box levels
- `shouldComputeBox(box, time)` - Check if computation needed

### 3. Signal Detector (`modules/signals/detector.ts`)

Detects BULL/BEAR signals based on price action.

```typescript
import { detectSignal } from './modules/signals/detector';

const signal = detectSignal(lastCandle, boxData, { boxBreakMargin: 0 });
// Returns: 'BULL' | 'BEAR' | null
```

**Detection Rules:**
- **BULL:** Close > boxHigh + margin AND green candle (close > open)
- **BEAR:** Close < boxLow - margin AND red candle (close < open)

**Exports:**
- `detectSignal(candle, box, config)` - Detect trading signal
- `validateReEntry(signal, candle, box, config)` - Validate re-entry
- `parseCandles(raw)` - Parse candle data
- `getRecentCandles(candles)` - Get last 2 candles

### 4. Trade Persistence (`modules/trades/persistence.ts`)

Manages trade history and active trades.

```typescript
import { recordTradeEntry, recordTradeExit } from './modules/trades/persistence';

// Record entry
const trade = recordTradeEntry(
  'BULL', 'NIFTY2601623700CE', 23700, 'CE',
  100, 150.50, 130.50, 185.50, config
);

// Record exit
recordTradeExit(185.75, 'TARGET', config);
```

**Exports:**
- `loadAllTrades(file)` - Load all trades
- `loadCurrentTrade(file)` - Load active trade
- `recordTradeEntry(...)` - Log new trade
- `recordTradeExit(price, reason, config)` - Log exit
- `getTodayClosedTrades(date, file)` - Get today's closed trades

### 5. Order Executor (`modules/orders/executor.ts`)

Handles order placement and execution.

```typescript
import { placeBuyOrder, placeSellOrder, getOptionLTP } from './modules/orders/executor';

// Place buy order
await placeBuyOrder(kite, instrument, 100, {
  exchange: 'NFO',
  product: 'NRML',
  validity: 'DAY',
  variety: 'regular'
});

// Get option price
const ltp = await getOptionLTP(kite, 'NIFTY2601623700CE');

// Place sell order (exit)
await placeSellOrder(kite, tradingsymbol, 100, config);
```

**Exports:**
- `placeBuyOrder(kite, instrument, qty, config)` - Place buy
- `placeSellOrder(kite, symbol, qty, config)` - Place sell
- `getSpotLTP(kite, symbol)` - Get index price
- `getOptionLTP(kite, symbol)` - Get option price
- `calculateStrikeAndType(signal, spot)` - Calculate strike
- `calculateLevels(entry, sl, target)` - Calculate SL/Target

### 6. Position Monitor (`modules/monitor/position.ts`)

Monitors positions and triggers exits.

```typescript
import { monitorAndExit } from './modules/monitor/position';

await monitorAndExit(
  kite,
  'NIFTY2601623700CE',
  150.50,    // entry price
  100,       // quantity
  130.50,    // stop loss
  185.50,    // target
  true,      // is bull trade
  monitorConfig,
  orderConfig,
  tradeConfig
);
```

**Features:**
- Polls LTP every N seconds
- Exits on SL hit (price <= stopLoss)
- Exits on Target hit (price >= target)
- Automatic EOD exit at 15:30
- Records exit reason and PnL

**Exports:**
- `monitorAndExit(...)` - Main monitoring loop
- `isMarketClosed(closeTime)` - Check if market closed
- `isTradingTime(open, close)` - Check trading hours

## 🔄 Trading Flow

```
Initialize → Load Data → Main Loop
                            ↓
                    Fetch Candles
                            ↓
                    Compute Box (if needed)
                            ↓
                    Detect Signal
                            ↓
                    Validate Entry
                            ↓
                    Execute Trade
                            ↓
                    Monitor Position
                            ↓
                    Exit (SL/Target/EOD)
                            ↓
                    Ready for Re-entry
```

## 📊 API Endpoints

### Market Data
```
GET /candles         - Recent price candles
GET /box             - Current box levels
```

### Trade Data
```
GET /trades          - All trades
GET /trades/today    - Today's trades
GET /current-trade   - Active trade
```

### Account
```
GET /holdings        - Portfolio holdings
```

## 🛠️ Development

### Test Individual Modules

```bash
# Test instruments parser
npm run test:instruments

# Test box calculator
npm run test:box

# Test signal detector
npm run test:signals

# Test trade persistence
npm run test:trades

# Test order executor
npm run test:orders

# Test position monitor
npm run test:monitor
```

### Build Project

```bash
npm run build
```

Output will be in `./dist/` directory.

### Run in Development Mode

```bash
npm run dev
```

## 🔐 Safety Features

- ✅ Only one active position at a time
- ✅ Duplicate signal prevention
- ✅ Strict re-entry validation
- ✅ Automatic EOD square-off
- ✅ Persistent trade logging
- ✅ Comprehensive error handling
- ✅ Type-safe TypeScript code

## ⚙️ Configuration

All settings are in `.env` file:

- **Box Settings:** Define box calculation period
- **Trading Settings:** Lot size, strike rounding
- **Risk Management:** SL distance, target points
- **Timing:** Check intervals, market hours
- **Files:** Data persistence locations

## 📝 Trade Re-Entry Logic

The system implements intelligent re-entry:

1. **First Trade:** Execute on box breakout
2. **Exit:** Close on SL/Target/EOD
3. **Re-Entry:** Only if:
   - No active trade exists
   - Price breaks box boundary again
   - Proper candle closing (green for BULL, red for BEAR)
   - Fresh breakout (new candle)

See `TRADE_REENTRY_LOGIC.md` for detailed explanation.

## 📚 Additional Documentation

- `MODULAR_ARCHITECTURE.md` - Complete module documentation
- `QUICK_REFERENCE.md` - Cheat sheet and common patterns
- `TRADE_REENTRY_LOGIC.md` - Re-entry rules and examples

## 🐛 Troubleshooting

### TypeScript Errors

All TypeScript errors have been fixed! The project compiles cleanly with:
- ✅ Strict type checking
- ✅ Exact optional property types
- ✅ No unchecked indexed access
- ✅ Full type safety

### Common Issues

**"Could not read instruments.csv"**
- Download instruments.csv from Kite Connect

**"Box not yet computed"**
- Wait until after BOX_END time (09:30)
- Or manually trigger computation

**"Option not found"**
- Check expiry date and strike price
- Verify instruments.csv is up to date

## ⚠️ Disclaimer

This is educational code for learning algorithmic trading concepts. Always:
- Test with paper trading first
- Understand the risks involved
- Never trade with money you can't afford to lose
- Past performance doesn't guarantee future results

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Contributions welcome! Each module is independent and testable:

1. Identify relevant module
2. Add feature with clear exports
3. Update documentation
4. Test in isolation
5. Integrate with main engine

---

**Ready to Trade!** 🚀

All TypeScript errors are fixed and the system is production-ready.
