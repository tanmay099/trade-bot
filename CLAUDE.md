# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm start              # Run live trading server (node main-server-ticker.js)
npm run start:paper    # Run in paper trade mode (PAPER_TRADE_MODE=true)
npm run dev            # Dev mode via tsx (no build needed)

# Test individual modules without starting server
npm run test:instruments
npm run test:box
npm run test:signals
npm run test:trades
npm run test:orders
npm run test:monitor
```

The server must be built before running (`npm run build`), unless using `npm run dev`. Compiled output goes to `dist/`.

## Architecture

The bot implements a **NIFTY options box breakout strategy** using Zerodha's Kite Connect API with WebSocket streaming.

**Entry point:** `main-server-ticker.js` — Express server handling OAuth login (`/login`, `/callback`), then starts `ticker-trading-engine.ts`.

**Core trading flow:**
1. **Login** → Kite OAuth → `accessToken` set → engine starts
2. **Box computation** (09:15–09:30): Fetches 5-min candles, computes High/Low → saved to `box.json`
3. **Signal detection** (post 09:30): Each completed candle checked against box levels — BULL if `close > boxHigh` + green candle; BEAR if `close < boxLow` + red candle
4. **Trade entry**: Buys ITM options (spot ±200 pts rounded to nearest 50) — BULL → CE, BEAR → PE
5. **Position monitoring**: `TickerPositionMonitor` watches live ticks for SL/Target/EOD hits

**Module responsibilities:**
- `modules/instruments/parser.ts` — Loads `instruments.csv` (15 MB Kite dump), finds NIFTY token, finds option by strike/expiry
- `modules/box/calculator.ts` — Computes and persists daily box; rejects stale boxes from prior days
- `modules/signals/detector.ts` — `detectSignal()`, `validateFreshBreakout()`, `validateReEntry()` — re-entry is only allowed if price returned inside the box after the previous trade's exit
- `modules/orders/executor.ts` — `placeBuyOrder()` / `placeSellOrder()`; paper mode returns fake IDs without touching Kite
- `modules/trades/persistence.ts` — Writes to `trades.json` (all history) and `current_trade.json` (active trade only)
- `modules/monitor/ticker-position-monitor.ts` — Real-time SL/Target/trailing-SL checks on every WebSocket tick
- `ticker-manager.ts` — Manages the KiteTicker WebSocket connection, subscriptions, and tick caching

**Key data files (runtime):**
- `box.json` — Today's box high/low (regenerated each trading day)
- `current_trade.json` — Active open trade; deleted/cleared on exit
- `trades.json` — Persistent trade history with P/L

## Environment Variables

Key vars from `.env` that drive strategy behavior:

| Variable | Default | Purpose |
|---|---|---|
| `PAPER_TRADE_MODE` | `true` | Simulates orders without real money |
| `BOX_START` / `BOX_END` | `09:15` / `09:30` | Box formation window |
| `BOX_BREAK_MARGIN` | `0` | Extra points price must clear box boundary |
| `SL_BUFFER` | `20` | Stop loss = entry − 20 pts |
| `TARGET_MIN` | `30` | Target = entry + 30 pts |
| `LOT_MULTIPLIER` | `2` | Quantity multiplier per lot |
| `MARKET_CLOSE_TIME` | `15:20` | Force-exit all positions at this time |
| `INTERVAL` | `5minute` | Candle interval for signal detection |

## TypeScript Config

Strict mode is enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. All array indexing returns `T | undefined` — handle accordingly when modifying modules.

## Re-entry Logic

The most complex part of the strategy. After a trade exits, re-entry in the same direction is only allowed if:
1. At least one candle closes **inside** `[boxLow, boxHigh]` after the exit
2. A subsequent candle breaks out again with the correct color

See `BOX_BOUNDARY_REENTRY.md` and `modules/signals/detector.ts:validateReEntry()` for the full logic.
