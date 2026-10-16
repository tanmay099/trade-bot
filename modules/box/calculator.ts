/**
 * Box Calculation Module
 * Handles box high/low computation and persistence
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export interface BoxData {
  date: string;
  boxHigh: number;
  boxLow: number;
  start: string;
  end: string;
  computedAt: string;
}

export interface BoxConfig {
  boxStart: string;
  boxEnd: string;
  interval: string;
  boxJsonFile: string;
  boxBreakMargin: number;
}

/**
 * Loads persisted box data from file.
 * Returns null if the file doesn't exist, is invalid, or is from a previous day.
 */
export function loadBoxFromFile(boxJsonFile: string): BoxData | null {
  try {
    if (existsSync(resolve(boxJsonFile))) {
      const raw = readFileSync(resolve(boxJsonFile), 'utf8');
      const j = JSON.parse(raw || '{}');

      if (j && j.date && j.boxHigh != null && j.boxLow != null) {
        const todayStr = new Date().toISOString().slice(0, 10);

        // Reject stale box from a previous trading day
        if (j.date !== todayStr) {
          console.info(
            `⚠️  Box file is from ${j.date} (today is ${todayStr}) — discarding stale box, will recompute after ${j.end || '09:30'}`
          );
          return null;
        }

        console.info(
          `✅ Loaded box for ${j.date} from ${boxJsonFile}: H=${j.boxHigh} L=${j.boxLow} (computed at ${j.computedAt})`
        );
        return {
          date: j.date,
          boxHigh: Number(j.boxHigh),
          boxLow: Number(j.boxLow),
          start: j.start,
          end: j.end,
          computedAt: j.computedAt
        };
      }
    }
  } catch (e: any) {
    console.warn('Failed to load box file:', e?.message ?? e);
  }
  return null;
}

/**
 * Computes box high/low for today using historical candles
 */
export async function computeBoxForToday(
  kite: any,
  instrumentToken: number | string,
  config: BoxConfig
): Promise<BoxData | null> {
  try {
    const now = new Date();
    const todayStr = dateOnlyString(now);
    
    // Build from/to Date objects for today's BOX_START/BOX_END
    const bsParts = config.boxStart.split(':');
    const beParts = config.boxEnd.split(':');
    const bs_h = Number(bsParts[0] || 0);
    const bs_m = Number(bsParts[1] || 0);
    const be_h = Number(beParts[0] || 0);
    const be_m = Number(beParts[1] || 0);
    
    const fromDt = new Date(now);
    fromDt.setHours(bs_h, bs_m, 0, 0);
    
    const toDt = new Date(now);
    toDt.setHours(be_h, be_m, 0, 0);
    
    console.info(
      `Computing box for ${todayStr} ${config.boxStart} -> ${config.boxEnd}, token=${instrumentToken}`
    );
    
    // Fetch historical data
    let candles: any = null;
    try {
      if (typeof kite.getHistoricalData === 'function') {
        candles = await kite.getHistoricalData(instrumentToken, config.interval, fromDt, toDt);
      } else if (typeof kite.getHistorical === 'function') {
        candles = await kite.getHistorical(instrumentToken, config.interval, fromDt, toDt);
      } else if (typeof kite.getHistoricalDataAsync === 'function') {
        candles = await kite.getHistoricalDataAsync(instrumentToken, config.interval, fromDt, toDt);
      }
    } catch (e: any) {
      console.warn('Historical fetch for box failed:', e?.message ?? e);
      return null;
    }
    
    if (!candles || candles.length === 0) {
      console.warn('No candles available to compute box for today');
      return null;
    }
    
    // Parse candles and find high/low
    const df: any[] = candles.map((c: any) => ({
      date: new Date(c[0] || c.date || c.time),
      open: c[1] || c.open,
      high: c[2] || c.high,
      low: c[3] || c.low,
      close: c[4] || c.close
    }));
    
    let h = -Infinity;
    let l = Infinity;
    
    for (const r of df) {
      if (typeof r.high === 'number') h = Math.max(h, r.high);
      if (typeof r.low === 'number') l = Math.min(l, r.low);
    }
    
    if (h === -Infinity || l === Infinity) {
      console.warn('Unable to compute box high/low from candles');
      return null;
    }
    
    const boxData: BoxData = {
      date: todayStr,
      boxHigh: h,
      boxLow: l,
      start: config.boxStart,
      end: config.boxEnd,
      computedAt: new Date().toISOString()
    };
    
    // Persist to file
    try {
      writeFileSync(
        resolve(config.boxJsonFile),
        JSON.stringify(boxData, null, 2),
        'utf8'
      );
      console.info(`✅ Saved box for ${todayStr} to ${config.boxJsonFile}: H=${h.toFixed(2)} L=${l.toFixed(2)} (computed at ${boxData.computedAt})`);
    } catch (e: any) {
      console.warn('Failed to write box file:', e?.message ?? e);
    }
    
    return boxData;
  } catch (e: any) {
    console.error('compute_box_for_today error:', e?.message ?? e);
    return null;
  }
}

/**
 * Checks if box should be computed for today
 */
export function shouldComputeBox(
  currentBoxData: BoxData | null,
  currentTime: string
): boolean {
  const now = new Date();
  const todayStr = dateOnlyString(now);
  
  // Box not computed yet for today, and it's past box end time
  return (!currentBoxData || currentBoxData.date !== todayStr);
}

/**
 * Utility: Get date-only string (YYYY-MM-DD)
 */
function dateOnlyString(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
