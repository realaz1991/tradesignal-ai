// services/TwelveDataService.js
'use strict';

const { Candle } = require('../models/Candle');
const IndicatorService = require('./IndicatorService');

const BASE_URL = 'https://api.twelvedata.com';

// ─── Rate limiter ─────────────────────────────────────────────────
class RateLimiter {
  constructor(requestsPerMinute = 8) {
    this.limit    = requestsPerMinute;
    this.queue    = [];
    this.running  = 0;
    this.calls    = [];  // timestamps of calls this minute
  }

  _callsThisMinute() {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < 60000);
    return this.calls.length;
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._tick();
    });
  }

  async _tick() {
    if (this.running >= this.limit) return;
    const item = this.queue.shift();
    if (!item) return;

    // Wait if we're at the per-minute limit
    while (this._callsThisMinute() >= this.limit) {
      await new Promise(r => setTimeout(r, 1000));
    }

    this.running++;
    this.calls.push(Date.now());
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    } finally {
      this.running--;
      this._tick();
    }
  }
}

// ─── Cache ────────────────────────────────────────────────────────
class DataCache {
  constructor(ttlMs = 60000) {
    this.ttl   = ttlMs;
    this._store = new Map();
  }

  set(key, value) {
    this._store.set(key, { value, ts: Date.now() });
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) { this._store.delete(key); return null; }
    return entry.value;
  }

  has(key) { return this.get(key) !== null; }

  invalidate(key) { this._store.delete(key); }

  stats() {
    return { size: this._store.size, keys: Array.from(this._store.keys()) };
  }
}

// ─── TwelveDataService ────────────────────────────────────────────
class TwelveDataService {
  constructor(apiKey) {
    if (!apiKey) throw new Error('API key gerekli');
    this.apiKey      = apiKey;
    this.rateLimiter = new RateLimiter(8);   // Free tier: 8 req/min
    this.candleCache = new DataCache(60000); // 1 min TTL for candles
    this.priceCache  = new DataCache(15000); // 15 sec TTL for price
    this.requestCount = 0;
    this.errors       = [];
  }

  // ── HTTP ─────────────────────────────────────────────────────────
  async _get(endpoint, params = {}) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    url.searchParams.set('apikey', this.apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();

    if (data.code === 429 || (data.message || '').toLowerCase().includes('limit')) {
      throw new Error('RATE_LIMIT');
    }
    if (data.status === 'error') throw new Error(data.message || 'API error');
    this.requestCount++;
    return data;
  }

  // ── Live Price ───────────────────────────────────────────────────
  async getLivePrice(tdSymbol) {
    const cacheKey = `price_${tdSymbol}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached) return cached;

    const data = await this.rateLimiter.execute(() =>
      this._get('/price', { symbol: tdSymbol })
    );
    const price = parseFloat(data.price);
    this.priceCache.set(cacheKey, price);
    return price;
  }

  // ── Quote (price + open + high + low + prev_close) ──────────────
  async getQuote(tdSymbol) {
    const cacheKey = `quote_${tdSymbol}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached) return cached;

    const data = await this.rateLimiter.execute(() =>
      this._get('/quote', { symbol: tdSymbol })
    );
    const quote = {
      price:     parseFloat(data.close),
      open:      parseFloat(data.open),
      high:      parseFloat(data.high),
      low:       parseFloat(data.low),
      prevClose: parseFloat(data.previous_close),
      change:    parseFloat(data.change),
      changePct: parseFloat(data.percent_change),
      volume:    data.volume,
      name:      data.name,
    };
    this.priceCache.set(cacheKey, quote);
    return quote;
  }

  // ── Time Series ──────────────────────────────────────────────────
  async getCandles(tdSymbol, interval, outputsize = 120) {
    const cacheKey = `candles_${tdSymbol}_${interval}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached) return cached;

    const data = await this.rateLimiter.execute(() =>
      this._get('/time_series', {
        symbol:     tdSymbol,
        interval,
        outputsize: String(outputsize),
        timezone:   'UTC',
      })
    );

    if (!data.values || !data.values.length) throw new Error('Veri yok');

    // Oldest → newest
    const candles = [...data.values]
      .reverse()
      .map(v => new Candle(v.datetime, v.open, v.high, v.low, v.close));

    // Deduplicate by timestamp
    const seen = new Set();
    const unique = candles.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    this.candleCache.set(cacheKey, unique);
    return unique;
  }

  // ── Full Market Data (candles + indicators + signal) ─────────────
  async getMarketData(tdSymbol, interval) {
    const candles = await this.getCandles(tdSymbol, interval);
    const indicators = IndicatorService.calculate(candles);
    const signal = IndicatorService.deriveSignal(indicators);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    return {
      candles,
      indicators,
      signal,
      lastCandle: last,
      price: last.close,
      prevClose: prev?.close,
      change: prev ? parseFloat((last.close - prev.close).toFixed(8)) : 0,
      changePct: prev ? parseFloat(((last.close - prev.close) / prev.close * 100).toFixed(4)) : 0,
    };
  }

  // ── Batch: all timeframes for one symbol ─────────────────────────
  async getAllTimeframes(tdSymbol, timeframes = ['5min','15min','30min','1h','4h','1day']) {
    const results = {};
    // Sequential to respect rate limiter
    for (const tf of timeframes) {
      try {
        results[tf] = await this.getMarketData(tdSymbol, tf);
      } catch (e) {
        this.errors.push({ symbol: tdSymbol, tf, error: e.message, ts: Date.now() });
        results[tf] = null;
      }
    }
    return results;
  }

  stats() {
    return {
      requestCount: this.requestCount,
      cacheStats:   { candles: this.candleCache.stats(), price: this.priceCache.stats() },
      recentErrors: this.errors.slice(-5),
    };
  }
}

module.exports = TwelveDataService;
