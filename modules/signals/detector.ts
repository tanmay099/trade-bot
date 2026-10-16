/**
 * Signal Detection Module
 * Identifies BULL/BEAR signals based on box breakouts
 */

import { BoxData } from '../box/calculator';

export type SignalType = 'BULL' | 'BEAR' | null;

export interface Candle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SignalConfig {
  boxBreakMargin: number;
}

/**
 * Detects trading signal based on candle and box data
 */
export function detectSignal(
  lastCandle: Candle,
  boxData: BoxData | null,
  config: SignalConfig
): SignalType {
  if (!boxData || boxData.boxHigh == null || boxData.boxLow == null) {
    console.warn('Box not yet computed; waiting for box data before trading');
    return null;
  }
  
  const { boxHigh, boxLow } = boxData;
  const { close, open } = lastCandle;
  
  // BULL: Market breaks above upper boundary with GREEN candle
  if (close > (boxHigh + config.boxBreakMargin) && close > open) {
    console.info(
      `🟢 BULL signal: close=${close.toFixed(2)} > boxHigh=${boxHigh.toFixed(2)} AND close > open (GREEN candle)`
    );
    return 'BULL';
  }
  
  // BEAR: Market breaks below lower boundary with RED candle
  if (close < (boxLow - config.boxBreakMargin) && close < open) {
    console.info(
      `🔴 BEAR signal: close=${close.toFixed(2)} < boxLow=${boxLow.toFixed(2)} AND close < open (RED candle)`
    );
    return 'BEAR';
  }
  
  // Within box range - NO TRADE
  if (close > boxLow && close < boxHigh) {
    console.info(
      `⚪ Within box range [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}]: NO TRADE`
    );
  }
  
  return null;
}

/**
 * Validates if re-entry is allowed after a closed trade
 * This checks if:
 * 1. Price came back inside the box after previous trade closed
 * 2. Price is now breaking out of the box again (fresh breakout)
 *
 * IMPORTANT: Uses candle data to verify price returned to box,
 * not just exit time. This prevents false re-entries when exit
 * data is incomplete.
 */
export function validateReEntry(
  signal: SignalType,
  lastCandle: Candle,
  previousCandles: Candle[],
  boxData: BoxData,
  config: SignalConfig,
  lastExitTime?: Date
): boolean {
  if (!signal || !boxData) return false;

  const { close, open } = lastCandle;
  const { boxHigh, boxLow } = boxData;

  if (boxHigh == null || boxLow == null) {
    console.info('⚠️  Box data incomplete - cannot validate re-entry');
    return false;
  }

  // Check if there were any candles INSIDE the box after the last exit
  // This ensures we're not re-entering on the same breakout
  let priceReturnedToBox = false;
  let returnToBoxTime: string | null = null;

  // CRITICAL FIX: Always check candle data for price returning to box
  // Don't skip validation just because lastExitTime is missing
  if (previousCandles.length > 0) {
    // If we have exit time, look at candles after exit
    // If not, look at recent candles to find if price was inside box before this breakout
    let candlesToCheck: Candle[];

    if (lastExitTime) {
      candlesToCheck = previousCandles.filter(c => c.date > lastExitTime);
    } else {
      // No exit time - check all candles from today's market open (9:15)
      // to find if price returned to box at some point
      const today = new Date();
      const marketOpen = new Date(today);
      marketOpen.setHours(9, 30, 0, 0); // After box formation time
      candlesToCheck = previousCandles.filter(c => c.date >= marketOpen);

      console.info(
        `⚠️  No exit time found for previous trade - checking ${candlesToCheck.length} candles after 9:30`
      );
    }

    // Find candles that were inside the box
    // We need to find a candle INSIDE the box that comes BEFORE a breakout candle
    // This proves price returned to box after the previous breakout

    // First, find all breakout candles (outside box)
    // IMPORTANT: Use the SAME criteria as detectSignal() - must be a valid signal candle
    // (not just price outside box, but also correct candle color)
    const breakoutCandles = candlesToCheck.filter(c => {
      if (signal === 'BULL') {
        // BULL requires: close > boxHigh AND green candle (close > open)
        return c.close > boxHigh && c.close > c.open;
      } else {
        // BEAR requires: close < boxLow AND red candle (close < open)
        return c.close < boxLow && c.close < c.open;
      }
    });

    // If there are no breakout candles before this one, this might be first trade
    if (breakoutCandles.length === 0) {
      // Check if any candle was inside box
      for (const candle of candlesToCheck) {
        if (candle.close >= boxLow && candle.close <= boxHigh) {
          priceReturnedToBox = true;
          returnToBoxTime = candle.date.toTimeString().slice(0, 8);
          break;
        }
      }
    } else {
      // There were previous breakouts - check if price returned to box after any of them
      // Get the most recent breakout before the current candle
      const prevBreakouts = breakoutCandles.filter(c => c.date < lastCandle.date);

      if (prevBreakouts.length > 0) {
        const lastBreakout = prevBreakouts[prevBreakouts.length - 1];

        // Check if any candle AFTER that breakout was inside box
        const candlesAfterLastBreakout = candlesToCheck.filter(
          c => lastBreakout && c.date > lastBreakout.date && c.date < lastCandle.date
        );

        for (const candle of candlesAfterLastBreakout) {
          if (candle.close >= boxLow && candle.close <= boxHigh) {
            priceReturnedToBox = true;
            returnToBoxTime = candle.date.toTimeString().slice(0, 8);
            console.info(
              `📊 Price returned to box at ${returnToBoxTime}: ₹${candle.close.toFixed(2)} ` +
              `(inside [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}])`
            );
            break;
          }
        }

        if (!priceReturnedToBox) {
          console.info(
            `⚠️  Price never returned to box after last breakout at ${lastBreakout?.date.toTimeString().slice(0, 8)}\n` +
            `   This is the same breakout continuation - re-entry REJECTED`
          );
          return false;
        }
      } else {
        // No previous breakout before current candle - this is first breakout
        // Check if there were any candles inside box before this
        for (const candle of candlesToCheck) {
          if (candle.date < lastCandle.date && candle.close >= boxLow && candle.close <= boxHigh) {
            priceReturnedToBox = true;
            returnToBoxTime = candle.date.toTimeString().slice(0, 8);
            break;
          }
        }
      }
    }

    // If we checked candles and found NO return to box, reject
    if (!priceReturnedToBox && candlesToCheck.length > 0) {
      console.info(
        `⚠️  Price never returned to box - same breakout continuation (checked ${candlesToCheck.length} candles)`
      );
      return false;
    }
  }

  // Now check if we have a fresh breakout
  if (signal === 'BULL') {
    // For BULL re-entry: price must break above box high with green candle
    const breakingOut = close > (boxHigh + config.boxBreakMargin);
    const greenCandle = close > open;

    if (breakingOut && greenCandle) {
      console.info(
        `✅ Valid BULL re-entry: Fresh breakout above box high detected\n` +
        `   Close: ${close.toFixed(2)} > Box High: ${boxHigh.toFixed(2)}\n` +
        `   Green candle: Close (${close.toFixed(2)}) > Open (${open.toFixed(2)})\n` +
        `   Price returned to box: ${priceReturnedToBox ? `Yes ✓ at ${returnToBoxTime}` : 'No (first trade)'}`
      );
      return true;
    } else {
      console.info(
        `❌ Invalid BULL re-entry:\n` +
        `   Breaking out: ${breakingOut ? 'Yes ✓' : 'No ✗'} (${close.toFixed(2)} vs ${boxHigh.toFixed(2)})\n` +
        `   Green candle: ${greenCandle ? 'Yes ✓' : 'No ✗'} (${close.toFixed(2)} vs ${open.toFixed(2)})`
      );
      return false;
    }
  } else if (signal === 'BEAR') {
    // For BEAR re-entry: price must break below box low with red candle
    const breakingOut = close < (boxLow - config.boxBreakMargin);
    const redCandle = close < open;

    if (breakingOut && redCandle) {
      console.info(
        `✅ Valid BEAR re-entry: Fresh breakout below box low detected\n` +
        `   Close: ${close.toFixed(2)} < Box Low: ${boxLow.toFixed(2)}\n` +
        `   Red candle: Close (${close.toFixed(2)}) < Open (${open.toFixed(2)})\n` +
        `   Price returned to box: ${priceReturnedToBox ? `Yes ✓ at ${returnToBoxTime}` : 'No (first trade)'}`
      );
      return true;
    } else {
      console.info(
        `❌ Invalid BEAR re-entry:\n` +
        `   Breaking out: ${breakingOut ? 'Yes ✓' : 'No ✗'} (${close.toFixed(2)} vs ${boxLow.toFixed(2)})\n` +
        `   Red candle: ${redCandle ? 'Yes ✓' : 'No ✗'} (${close.toFixed(2)} vs ${open.toFixed(2)})`
      );
      return false;
    }
  }

  return false;
}

/**
 * Validates if this is a FRESH breakout (not a stale one from earlier)
 * Used for FIRST TRADE of the day when server starts late
 *
 * A breakout is considered STALE if:
 * - There were already candles that broke the box BEFORE this candle
 * - Price has been outside the box continuously (never returned)
 *
 * A breakout is considered FRESH if:
 * - This is the FIRST candle to break the box, OR
 * - Price returned to box after a previous breakout and is now breaking out again
 */
export function validateFreshBreakout(
  signal: SignalType,
  lastCandle: Candle,
  previousCandles: Candle[],
  boxData: BoxData,
  config: SignalConfig
): { isValid: boolean; reason: string } {
  if (!signal || !boxData) {
    return { isValid: false, reason: 'No signal or box data' };
  }

  const { boxHigh, boxLow } = boxData;

  if (boxHigh == null || boxLow == null) {
    return { isValid: false, reason: 'Box data incomplete' };
  }

  // Filter candles after box formation (9:30)
  const today = new Date();
  const boxEndTime = new Date(today);
  boxEndTime.setHours(9, 30, 0, 0);

  const candlesAfterBox = previousCandles.filter(c =>
    c.date >= boxEndTime && c.date < lastCandle.date
  );

  if (candlesAfterBox.length === 0) {
    // No previous candles - this is first candle after box, valid
    return {
      isValid: true,
      reason: 'First candle after box formation - fresh breakout'
    };
  }

  // Check if there were previous breakout candles in the same direction
  // IMPORTANT: Use the SAME criteria as detectSignal() - must be a valid signal candle
  // (not just price outside box, but also correct candle color)
  const previousBreakouts = candlesAfterBox.filter(c => {
    if (signal === 'BULL') {
      // BULL requires: close > boxHigh AND green candle (close > open)
      return c.close > boxHigh && c.close > c.open;
    } else {
      // BEAR requires: close < boxLow AND red candle (close < open)
      return c.close < boxLow && c.close < c.open;
    }
  });

  if (previousBreakouts.length === 0) {
    // No previous breakouts in this direction - this is fresh
    return {
      isValid: true,
      reason: `First ${signal} breakout of the day - fresh breakout`
    };
  }

  // There were previous breakouts - check if price returned to box after them
  const lastPrevBreakout = previousBreakouts[previousBreakouts.length - 1];

  if (!lastPrevBreakout) {
    return { isValid: true, reason: 'No valid previous breakout found' };
  }

  // Get candles between last breakout and current candle
  const candlesBetween = candlesAfterBox.filter(
    c => c.date > lastPrevBreakout.date
  );

  // Check if any candle returned to box
  let priceReturnedToBox = false;
  let returnTime: string | null = null;

  for (const candle of candlesBetween) {
    if (candle.close >= boxLow && candle.close <= boxHigh) {
      priceReturnedToBox = true;
      returnTime = candle.date.toTimeString().slice(0, 8);
      break;
    }
  }

  if (priceReturnedToBox) {
    return {
      isValid: true,
      reason: `Price returned to box at ${returnTime} after previous breakout - fresh breakout`
    };
  }

  // Price never returned to box - this is a STALE breakout
  const breakoutTime = lastPrevBreakout.date.toTimeString().slice(0, 8);
  const candleCount = candlesBetween.length;

  console.info(
    `\n⚠️  STALE BREAKOUT DETECTED!\n` +
    `   Previous ${signal} breakout at: ${breakoutTime}\n` +
    `   Candles since breakout: ${candleCount}\n` +
    `   Price never returned to box [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}]\n` +
    `   This is NOT a fresh breakout - TRADE REJECTED\n`
  );

  return {
    isValid: false,
    reason: `Stale breakout - price already broke ${signal === 'BULL' ? 'above' : 'below'} box at ${breakoutTime} and never returned`
  };
}

/**
 * Parses raw candle data into Candle objects
 */
export function parseCandles(rawCandles: any[]): Candle[] {
  return rawCandles.map((c: any) => ({
    date: new Date(c[0] || c.date || c.time),
    open: c[1] || c.open,
    high: c[2] || c.high,
    low: c[3] || c.low,
    close: c[4] || c.close
  }));
}

/**
 * Gets the latest two candles (previous and current)
 */
export function getRecentCandles(candles: Candle[]): {
  prev: Candle | null;
  last: Candle | null;
} {
  if (candles.length < 2) {
    return { prev: null, last: null };
  }
  
  return {
    prev: candles[candles.length - 2] || null,
    last: candles[candles.length - 1] || null
  };
}
