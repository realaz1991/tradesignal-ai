// services/FinnhubService.js
// Finnhub = Canlı fiyat (WebSocket)
// Twelve Data = Mum verisi (REST, ücretsiz 800/gün)
'use strict';

const { Candle } = require('../models/Candle');
const IndicatorService = require('./IndicatorService');

const FH_WS  = 'wss://ws.finnhub.io';
const TD_URL  = 'https://api.twelvedata.com';

// Finnhub WebSocket sembol haritası
const FH_SYMBOLS = {
  'EUR/USD': 'OANDA:EUR_USD',
  'GBP/USD': 'OANDA:GBP_USD',
  'USD/JPY': 'OANDA:USD_JPY',
  'AUD/USD': 'OANDA:AUD_USD',
  'USD/CHF': 'OANDA:USD_CHF',
  'XAU/USD': 'OANDA:XAU_USD',
  'WTI':     'OANDA:BCO_USD',
  'BRENT':   'OANDA:BCO_USD',
  'XAG/USD': 'OANDA:XAG_USD',
};

// Twelve Data sembol haritası (mum verisi için)
const TD_SYMBOLS = {
  'EUR/USD': 'EUR/USD',
  'GBP/USD': 'GBP/USD',
  'USD/JPY': 'USD/JPY',
  'AUD/USD': 'AUD/USD',
  'USD/CHF': 'USD/CHF',
  'XAU/USD': 'XAU/USD',
  'WTI':     'WTI/USD',
  'BRENT':   'BZ/USD',
  'XAG/USD': 'XAG/USD',
};

// ─── Cache ─────────────────────────────────────────────────────────
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
  stats() { return { size: this._store.size }; }
}

// ─── HybridService ─────────────────────────────────────────────────
class FinnhubService {
  constructor(apiKey) {
    // apiKey = FINNHUB_API_KEY
    // tdKey  = TWELVE_DATA_API_KEY (env'den)
    this.apiKey      = apiKey;
    this.tdKey       = process.env.TWELVE_DATA_API_KEY || '';
    this.candleCache = new DataCache(60000);
    this.priceCache  = new DataCache(10000);
    this.requestCount = 0;
    this.errors       = [];
    this._livePrices  = new Map();
    this._ws          = null;
    this._wsReady     = false;
  }

  // ── Twelve Data REST (mum verisi) ─────────────────────────────────
  async _tdGet(path, params = {}) {
    const url = new URL(`${TD_URL}${path}`);
    url.searchParams.set('apikey', this.tdKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`TD HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message || 'TD API hatası');
    this.requestCount++;
    return data;
  }

  // ── Mum verisi — Twelve Data ──────────────────────────────────────
  async getCandles(symbol, tf, limit = 120) {
    const ck = `candles_${symbol}_${tf}`;
    const cached = this.candleCache.get(ck);
    if (cached) return cached;

    const tdSym = TD_SYMBOLS[symbol];
    if (!tdSym) throw new Error(`Bilinmeyen sembol: ${symbol}`);

    const data = await this._tdGet('/time_series', {
      symbol:     tdSym,
      interval:   tf,
      outputsize: limit,
      timezone:   'UTC',
    });

    if (!data.values?.length) throw new Error('Veri yok');

    const candles = [...data.values].reverse().map(v => {
      const dt = v.datetime.includes('T') ? v.datetime : v.datetime.replace(' ', 'T') + '+00:00';
      return new Candle(
        Math.floor(new Date(dt).getTime() / 1000),
        parseFloat(v.open), parseFloat(v.high),
        parseFloat(v.low),  parseFloat(v.close)
      );
    });

    // Duplicate temizle
    const seen   = new Set();
    const unique = candles.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time); return true;
    });

    this.candleCache.set(ck, unique);
    return unique;
  }

  // ── Anlık fiyat — önce Finnhub WS, sonra TD ───────────────────────
  async getLivePrice(symbol) {
    const live = this._livePrices.get(symbol);
    if (live) return live.price;
    const ck = `price_${symbol}`;
    const cached = this.priceCache.get(ck);
    if (cached) return cached;
    // TD'den al
    const tdSym = TD_SYMBOLS[symbol];
    if (!tdSym) return null;
    const data = await this._tdGet('/price', { symbol: tdSym });
    const price = parseFloat(data.price);
    this.priceCache.set(ck, price);
    return price;
  }

  // ── Quote ──────────────────────────────────────────────────────────
  async getQuote(symbol) {
    const candles = await this.getCandles(symbol, '1h', 2);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    // Canlı fiyat varsa kullan
    const lp   = this._livePrices.get(symbol);
    const price = lp?.price || last.close;
    const change = prev ? price - prev.close : 0;
    return {
      price,
      open:      last.open,
      high:      last.high,
      low:       last.low,
      prevClose: prev?.close,
      change:    parseFloat(change.toFixed(8)),
      changePct: prev ? parseFloat((change / prev.close * 100).toFixed(4)) : 0,
    };
  }

  // ── Tam piyasa verisi ──────────────────────────────────────────────
  async getMarketData(symbol, tf) {
    const candles    = await this.getCandles(symbol, tf);
    const indicators = IndicatorService.calculate(candles);
    const signal     = IndicatorService.deriveSignal(indicators);
    const last       = candles[candles.length - 1];
    const prev       = candles[candles.length - 2];
    const lp         = this._livePrices.get(symbol);
    const price      = lp?.price || last.close;

    return {
      candles, indicators, signal,
      lastCandle: last,
      price,
      prevClose:  prev?.close,
      change:     prev ? parseFloat((price - prev.close).toFixed(8)) : 0,
      changePct:  prev ? parseFloat(((price - prev.close) / prev.close * 100).toFixed(4)) : 0,
    };
  }

  // ── Finnhub WebSocket — canlı fiyat ───────────────────────────────
  connectWebSocket(onPrice) {
    const WebSocket = require('ws');
    const url = `${FH_WS}?token=${this.apiKey}`;

    const connect = () => {
      console.log('[Finnhub WS] Bağlanıyor...');
      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        this._wsReady = true;
        console.log('[Finnhub WS] Bağlandı — semboller abone ediliyor');
        // Tekrar eden fh sembollerini filtrele
        const fhSyms = [...new Set(Object.values(FH_SYMBOLS))];
        fhSyms.forEach(fh => {
          this._ws.send(JSON.stringify({ type: 'subscribe', symbol: fh }));
          console.log('[Finnhub WS] Abone:', fh);
        });
      });

      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== 'trade' || !msg.data) return;

          msg.data.forEach(trade => {
            const price = trade.p;
            const ts    = trade.t;
            // Bu fh sembolüne karşılık gelen tüm sembollerimizi bul
            Object.entries(FH_SYMBOLS).forEach(([sym, fh]) => {
              if (fh !== trade.s) return;
              this._livePrices.set(sym, { price, ts });
              this.priceCache.set(`price_${sym}`, price);
              if (onPrice) onPrice(sym, price, ts);
            });
          });
        } catch {}
      });

      this._ws.on('close', () => {
        this._wsReady = false;
        console.log('[Finnhub WS] Kesildi, 5sn sonra tekrar...');
        setTimeout(connect, 5000);
      });

      this._ws.on('error', e => console.warn('[Finnhub WS] Hata:', e.message));
    };

    connect();
  }

  getLivePrices() { return this._livePrices; }

  stats() {
    return {
      requestCount: this.requestCount,
      wsConnected:  this._wsReady,
      livePrices:   this._livePrices.size,
      cache: { candles: this.candleCache.stats(), price: this.priceCache.stats() },
      recentErrors: this.errors.slice(-5),
    };
  }
}

module.exports = FinnhubService;
