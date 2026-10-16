/**
 * Instruments CSV Parser Module
 * Handles parsing and searching of instrument data
 * Supports automatic download from Kite API
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

export interface Instrument {
  [key: string]: string;
}

/**
 * Splits a CSV line handling quoted fields and commas inside quotes
 */
function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

/**
 * Parses CSV text into array of instrument objects
 */
export function parseCSV(csvText: string): Instrument[] {
  const lines: string[] = csvText.split(/\r?\n/).filter((l: string) => l.trim() !== '');
  if (lines.length === 0) return [];
  
  const headers = splitCSVLine(lines[0] || '');
  return lines.slice(1).map((line: string) => {
    const vals = splitCSVLine(line);
    const obj: Instrument = {};
    for (let i = 0; i < headers.length; i++) {
      const rawKey = headers[i] ?? `col${i}`;
      const key = String(rawKey).trim();
      obj[key] = vals[i] !== undefined ? String(vals[i]) : '';
    }
    return obj;
  });
}

/**
 * Loads instruments from CSV file
 */
export function loadInstruments(filePath: string): Instrument[] {
  try {
    const instrumentsCsv = readFileSync(resolve(filePath), 'utf8');
    return parseCSV(instrumentsCsv);
  } catch (e: any) {
    console.warn('Could not read instruments.csv:', e?.message ?? e);
    return [];
  }
}

/**
 * Finds index instrument by symbol hint (e.g., 'NIFTY', 'BANKNIFTY')
 */
export function findIndexRow(
  instruments: Instrument[],
  symbolHint: string = 'NIFTY'
): Instrument | null {
  const matches = instruments.filter((r: Instrument) => {
    const ts = (r['tradingsymbol'] || '').toString();
    return ts.toLowerCase().includes(symbolHint.toLowerCase());
  });
  
  console.log(`Found ${matches.length} matches for index symbol hint '${symbolHint}'`);
  if (matches.length === 0) return null;
  
  // Prefer instrument_type == INDEX or segment == INDICES
  const idx = matches.find((r) => 
    (r['segment'] || '').toUpperCase() === 'INDICES'
  );
  return idx || matches[0] || null;
}

/**
 * Finds option instrument matching criteria
 */
export function findOptionInstrument(
  instruments: Instrument[],
  underlyingSymbol: string,
  expiryDate: Date | null,
  strike: number,
  optionType: string
): Instrument | null {
  let df = instruments.slice();
  
  // Filter by underlying symbol and option type
  df = df.filter((r: Instrument) => {
    if (r['tradingsymbol'] == null) return false;
    const ts = r['tradingsymbol'];
    if (!ts.toString().toLowerCase().includes(underlyingSymbol.toLowerCase())) return false;
    if (!ts.toString().toLowerCase().includes(optionType.toLowerCase())) return false;
    return true;
  });
  
  if (df.length === 0) return null;
  
  // Filter by expiry date if provided
  const expiryStr = expiryDate ? dateOnlyString(expiryDate) : null;
  if (expiryStr) {
    const matchingExpiry = df.filter((r: Instrument) => {
      if (!r['expiry']) return false;
      try {
        const rexp = dateOnlyString(new Date(r['expiry']));
        return rexp === expiryStr;
      } catch {
        return (r['expiry'] || '').toString().includes(expiryStr);
      }
    });
    
    if (matchingExpiry.length > 0) {
      df = matchingExpiry;
    }
  }
  
  // Find exact strike match
  const byStrike = df.find((r) => {
    if (r['strike'] !== undefined && r['strike'] !== '') {
      return Number(r['strike']) === strike;
    }
    return r['tradingsymbol']?.toString().includes(strike.toString());
  });
  
  return byStrike || df[0] || null;
}

/**
 * Utility: Get date-only string (YYYY-MM-DD)
 */
function dateOnlyString(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/**
 * Calculate nearest weekly expiry (Tuesday for Nifty)
 */
export function nearestWeeklyExpiry(fromDate?: Date): Date {
  const d = fromDate ? new Date(fromDate) : new Date();
  const wd = d.getDay();
  const daysAhead = (2 - wd + 7) % 7; // Tuesday is 2 in JS (Sun=0)
  
  if (daysAhead === 0) return d;
  
  const res = new Date(d);
  res.setDate(d.getDate() + daysAhead);
  return res;
}

/**
 * Round strike price to nearest multiple
 */
export function roundStrike(price: number, roundTo: number = 50): number {
  return Math.round(price / roundTo) * roundTo;
}

// CSV column headers matching the Kite instruments dump format
const INSTRUMENT_CSV_HEADERS = [
  'instrument_token', 'exchange_token', 'tradingsymbol', 'name',
  'last_price', 'expiry', 'strike', 'tick_size', 'lot_size',
  'instrument_type', 'segment', 'exchange'
];

/**
 * Converts an array of Kite API instrument objects to CSV text.
 */
function instrumentsToCsv(instruments: Record<string, any>[]): string {
  const lines: string[] = [INSTRUMENT_CSV_HEADERS.join(',')];

  for (const inst of instruments) {
    const row = INSTRUMENT_CSV_HEADERS.map((h) => {
      let val = inst[h] ?? '';
      // Stringify everything
      val = String(val);
      // Quote values that contain commas or double-quotes
      if (val.includes(',') || val.includes('"')) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Checks if the instruments CSV file needs to be refreshed.
 * Returns true if the file doesn't exist or was last modified before today.
 */
export function isInstrumentsFileStale(filePath: string): boolean {
  try {
    const fullPath = resolve(filePath);
    if (!existsSync(fullPath)) {
      return true;
    }

    const stats = statSync(fullPath);
    const fileDate = stats.mtime.toISOString().slice(0, 10);
    const todayDate = new Date().toISOString().slice(0, 10);

    if (fileDate !== todayDate) {
      console.info(
        `📋 instruments.csv last modified on ${fileDate} (today is ${todayDate}) — needs refresh`
      );
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Downloads the latest instruments from Kite API and saves as CSV.
 *
 * Fetches NSE (for indices like NIFTY 50) and NFO (for F&O instruments)
 * segments, merges them, and writes the result to `filePath`.
 *
 * @param kite  An authenticated KiteConnect instance
 * @param filePath  Path to write the instruments CSV (e.g. 'instruments.csv')
 * @returns The parsed Instrument[] array
 */
export async function downloadAndSaveInstruments(
  kite: any,
  filePath: string
): Promise<Instrument[]> {
  console.info('📥 Downloading latest instruments from Kite API...');

  let allInstruments: Record<string, any>[] = [];

  // Fetch NSE instruments (includes NIFTY 50 index token)
  try {
    const nse = await kite.getInstruments('NSE');
    if (Array.isArray(nse)) {
      allInstruments = allInstruments.concat(nse);
      console.info(`  ✅ NSE: ${nse.length} instruments`);
    }
  } catch (e: any) {
    console.warn('  ⚠️  Failed to fetch NSE instruments:', e?.message ?? e);
  }

  // Fetch NFO instruments (options & futures)
  try {
    const nfo = await kite.getInstruments('NFO');
    if (Array.isArray(nfo)) {
      allInstruments = allInstruments.concat(nfo);
      console.info(`  ✅ NFO: ${nfo.length} instruments`);
    }
  } catch (e: any) {
    console.warn('  ⚠️  Failed to fetch NFO instruments:', e?.message ?? e);
  }

  if (allInstruments.length === 0) {
    console.error('❌ No instruments downloaded — falling back to existing CSV');
    return loadInstruments(filePath);
  }

  // Convert to CSV and write
  const csv = instrumentsToCsv(allInstruments);
  try {
    writeFileSync(resolve(filePath), csv, 'utf8');
    console.info(`✅ Saved ${allInstruments.length} instruments to ${filePath}`);
  } catch (e: any) {
    console.error('❌ Failed to write instruments CSV:', e?.message ?? e);
  }

  // Parse and return
  return parseCSV(csv);
}

/**
 * Ensures instruments are up-to-date.
 * Downloads fresh data if the file is stale (not from today),
 * otherwise loads from disk.
 *
 * @param kite  An authenticated KiteConnect instance
 * @param filePath  Path to the instruments CSV file
 * @returns The parsed Instrument[] array
 */
export async function ensureFreshInstruments(
  kite: any,
  filePath: string
): Promise<Instrument[]> {
  if (isInstrumentsFileStale(filePath)) {
    return downloadAndSaveInstruments(kite, filePath);
  }
  console.info('✅ instruments.csv is already up-to-date for today');
  return loadInstruments(filePath);
}
