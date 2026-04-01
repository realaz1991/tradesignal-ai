// services/PolygonService.js
'use strict';

const { Candle } = require('../models/Candle');
const IndicatorService = require('./IndicatorService');

const BASE_URL = 'https://api.polygon.io';

// Polygon zaman dilimi haritası
const TF_MAP = {
  '5min':  { multiplier: 5,  timespan: 'minute' },
  '15min': { multiplier: 15, timespan: 'minute' },
  '30min': { multiplier: 30, timespan: 'minute' },
  '1h':    { multiplier: 1,  timespan: 'hour'   },
  '4h':    { multiplier: 4,  timespan: 'hour'   },
  '1day':  { multiplier: 1,  timespan: 'day'    },
};

// Polygon sembol haritası (Forex ve Emtia)
const SYMBOL_MAP = {
  'EUR/USD': { type: 'forex',     poly: 'C:EURUSD'  },
  'GBP/USD': { type: 'forex',     poly: 'C:GBPUSD'  },
  'USD/JPY': { type: 'forex',     poly: 'C:USDJPY'  },
  'AUD/USD': { type: 'forex',     poly: 'C:AUDUSD'  },
  'USD/CHF': { type: 'forex',     poly: 'C:USDCHF'  },
  'XAU/USD': { type: 'forex',     poly: 'C:XAUUSD'  },
  'WTI':     { type: 'stocks',    poly: 'USO'       }, // ETF proxy
  'BRENT':   { type: 'stocks',    poly: 'BNO'       }, // ETF proxy
  'XAG/USD': { type: 'forex',     poly: 'C:XAGUSD'  },
};

// ─── Cache ────────────────────────────────────────────────────────
class DataCache {
  constructor(ttlMs = 60000) {
    this.ttl    = ttlMs;
    this._store = new Map();
  }
  set(key, value) { this._store.set(key, { value, ts: Date.now() }); }
  get(key) {
    const e = this._store.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > this.ttl) { this._store.delete(key); return null; }
    return e.value;
  }
  has(key) { return this.get(key) !== null; }
  stats()  { return { size: this._store.size }; }
}

// ─── PolygonService ───────────────────────────────────────────────
class PolygonService {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Polygon API key gerekli');
    this.apiKey      = apiKey;
    this.candleCache = new DataCache(60000);  // 1 dk
    this.priceCache  = new DataCache(10000);  // 10 sn
    this.requestCount = 0;
    this.errors       = [];
  }

  // ── HTTP ─────────────────────────────────────────────────────────
  async _get(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set('apiKey', this.apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'ERROR') throw new Error(data.error || 'Polygon API hatası');
    this.requestCount++;
    return data;
  }

  // ── Tarih yardımcıları ───────────────────────────────────────────
  _dateRange(tf) {
    const now  = new Date();
    const from = new Date(now);
    const tfMap = {
      '5min':  { days: 3   },
      '15min': { days: 7   },
      '30min': { days: 14  },
      '1h':    { days: 30  },
      '4h':    { days: 60  },
      '1day':  { days: 365 },
    };
    from.setDate(from.getDate() - (tfMap[tf]?.days || 30));
    return {
      from: from.toISOString().slice(0, 10),
      to:   now.toISOString().slice(0, 10),
    };
  }

  // ── Forex anlık fiyat ────────────────────────────────────────────
  async _getForexPrice(polySym) {
    // C:EURUSD → EURUSD
    const pair = polySym.replace('C:', '');
    const data = await this._get(`/v1/conversion/${pair.slice(0,3)}/${pair.slice(3)}`, {
      amount: 1, precision: 5
    });
    return data.converted || null;
  }

  // ── Stocks anlık fiyat ───────────────────────────────────────────
  async _getStockPrice(ticker) {
    const data = await this._get(`/v2/last/trade/${ticker}`);
    return data.results?.p || null;
  }

  // ── Forex mum verisi ─────────────────────────────────────────────
  async _getForexCandles(polySym, tf, limit = 120) {
    const { multiplier, timespan } = TF_MAP[tf];
    const { from, to } = this._dateRange(tf);
    const ticker = polySym; // C:EURUSD

    const data = await this._get(
      `/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}`,
      { adjusted: true, sort: 'asc', limit }
    );

    if (!data.results?.length) throw new Error('Veri yok');

    return data.results.map(r => new Candle(
      Math.floor(r.t / 1000), // ms → sn
      r.o, r.h, r.l, r.c
    ));
  }

  // ── Stocks mum verisi ────────────────────────────────────────────
  async _getStockCandles(ticker, tf, limit = 120) {
    const { multiplier, timespan } = TF_MAP[tf];
    const { from, to } = this._dateRange(tf);

    const data = await this._get(
      `/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}`,
      { adjusted: true, sort: 'asc', limit }
    );

    if (!data.results?.length) throw new Error('Veri yok');

    return data.results.map(r => new Candle(
      Math.floor(r.t / 1000),
      r.o, r.h, r.l, r.c
    ));
  }

  // ── Anlık fiyat (public) ─────────────────────────────────────────
  async getLivePrice(tdSymbol) {
    const ck = `price_${tdSymbol}`;
    const cached = this.priceCache.get(ck);
    if (cached) return cached;

    const info = SYMBOL_MAP[tdSymbol];
    if (!info) throw new Error(`Bilinmeyen sembol: ${tdSymbol}`);

    let price;
    if (info.type === 'forex') {
      price = await this._getForexPrice(info.poly);
    } else {
      price = await this._getStockPrice(info.poly);
    }

    this.priceCache.set(ck, price);
    return price;
  }

  // ── Mum verisi (public) ──────────────────────────────────────────
  async getCandles(tdSymbol, tf, limit = 120) {
    const ck = `candles_${tdSymbol}_${tf}`;
    const cached = this.candleCache.get(ck);
    if (cached) return cached;

    const info = SYMBOL_MAP[tdSymbol];
    if (!info) throw new Error(`Bilinmeyen sembol: ${tdSymbol}`);

    let candles;
    if (info.type === 'forex') {
      candles = await this._getForexCandles(info.poly, tf, limit);
    } else {
      candles = await this._getStockCandles(info.poly, tf, limit);
    }

    // Duplicate temizle
    const seen = new Set();
    const unique = candles.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    this.candleCache.set(ck, unique);
    return unique;
  }

  // ── Tam piyasa verisi ────────────────────────────────────────────
  async getMarketData(tdSymbol, tf) {
    const candles    = await this.getCandles(tdSymbol, tf);
    const indicators = IndicatorService.calculate(candles);
    const signal     = IndicatorService.deriveSignal(indicators);
    const last       = candles[candles.length - 1];
    const prev       = candles[candles.length - 2];

    return {
      candles,
      indicators,
      signal,
      lastCandle: last,
      price:      last.close,
      prevClose:  prev?.close,
      change:     prev ? parseFloat((last.close - prev.close).toFixed(8)) : 0,
      changePct:  prev ? parseFloat(((last.close - prev.close) / prev.close * 100).toFixed(4)) : 0,
    };
  }

  // ── Quote ────────────────────────────────────────────────────────
  async getQuote(tdSymbol) {
    const candles = await this.getCandles(tdSymbol, '1day', 2);
    const last    = candles[candles.length - 1];
    const prev    = candles[candles.length - 2];
    const change  = prev ? last.close - prev.close : 0;
    return {
      price:     last.close,
      open:      last.open,
      high:      last.high,
      low:       last.low,
      prevClose: prev?.close,
      change:    parseFloat(change.toFixed(8)),
      changePct: prev ? parseFloat((change / prev.close * 100).toFixed(4)) : 0,
    };
  }

  stats() {
    return {
      requestCount: this.requestCount,
      cache: { candles: this.candleCache.stats(), price: this.priceCache.stats() },
      recentErrors: this.errors.slice(-5),
    };
  }
}

module.exports = PolygonService;
