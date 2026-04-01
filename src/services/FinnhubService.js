// services/FinnhubService.js
'use strict';

const { Candle } = require('../models/Candle');
const IndicatorService = require('./IndicatorService');

const REST_URL = 'https://finnhub.io/api/v1';
const WS_URL   = 'wss://ws.finnhub.io';

// Finnhub sembol haritası
const SYMBOL_MAP = {
  'EUR/USD': { fh: 'OANDA:EUR_USD', type: 'forex' },
  'GBP/USD': { fh: 'OANDA:GBP_USD', type: 'forex' },
  'USD/JPY': { fh: 'OANDA:USD_JPY', type: 'forex' },
  'AUD/USD': { fh: 'OANDA:AUD_USD', type: 'forex' },
  'USD/CHF': { fh: 'OANDA:USD_CHF', type: 'forex' },
  'XAU/USD': { fh: 'OANDA:XAU_USD', type: 'forex' },
  'WTI':     { fh: 'OANDA:BCO_USD', type: 'forex' },
  'BRENT':   { fh: 'OANDA:BCO_USD', type: 'forex' },
  'XAG/USD': { fh: 'OANDA:XAG_USD', type: 'forex' },
};

// Candle interval → Finnhub resolution
const RESOLUTION_MAP = {
  '5min':  '5',
  '15min': '15',
  '30min': '30',
  '1h':    '60',
  '4h':    '240',
  '1day':  'D',
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

// ─── FinnhubService ────────────────────────────────────────────────
class FinnhubService {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Finnhub API key gerekli');
    this.apiKey      = apiKey;
    this.candleCache = new DataCache(60000);   // 1 dk
    this.priceCache  = new DataCache(15000);   // 15 sn
    this.requestCount = 0;
    this.errors       = [];

    // WebSocket için canlı fiyatlar
    this._livePrices = new Map(); // symbol → price
    this._ws         = null;
    this._wsReady    = false;
    this._listeners  = new Map(); // symbol → [fn]
  }

  // ── REST ─────────────────────────────────────────────────────────
  async _get(path, params = {}) {
    const url = new URL(`${REST_URL}${path}`);
    url.searchParams.set('token', this.apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    this.requestCount++;
    return data;
  }

  // ── WebSocket bağlantısı ─────────────────────────────────────────
  connectWebSocket(onPrice) {
    const WebSocket = require('ws');
    const url = `${WS_URL}?token=${this.apiKey}`;

    const connect = () => {
      console.log('[Finnhub WS] Bağlanıyor...');
      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        this._wsReady = true;
        console.log('[Finnhub WS] Bağlandı');
        // Tüm sembollere abone ol
        Object.values(SYMBOL_MAP).forEach(({ fh }) => {
          this._ws.send(JSON.stringify({ type: 'subscribe', symbol: fh }));
        });
      });

      this._ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== 'trade' || !msg.data) return;

          msg.data.forEach(trade => {
            const fhSym = trade.s;
            const price  = trade.p;
            const ts     = trade.t;

            // Hangi sembolümüz bu?
            const entry = Object.entries(SYMBOL_MAP).find(([, v]) => v.fh === fhSym);
            if (!entry) return;
            const [symbol] = entry;

            this._livePrices.set(symbol, { price, ts });
            this.priceCache.set(`price_${symbol}`, price);

            // Listener'ları çağır
            if (onPrice) onPrice(symbol, price, ts);
          });
        } catch {}
      });

      this._ws.on('close', () => {
        this._wsReady = false;
        console.log('[Finnhub WS] Bağlantı kesildi, 5sn sonra tekrar...');
        setTimeout(connect, 5000);
      });

      this._ws.on('error', (e) => {
        console.warn('[Finnhub WS] Hata:', e.message);
      });
    };

    connect();
  }

  // ── Anlık fiyat ──────────────────────────────────────────────────
  async getLivePrice(symbol) {
    // Önce WebSocket'ten bak
    const live = this._livePrices.get(symbol);
    if (live) return live.price;

    // Cache'e bak
    const ck = `price_${symbol}`;
    const cached = this.priceCache.get(ck);
    if (cached) return cached;

    // REST'ten al
    const info = SYMBOL_MAP[symbol];
    if (!info) throw new Error(`Bilinmeyen sembol: ${symbol}`);

    const data = await this._get('/quote', { symbol: info.fh });
    const price = data.c || data.pc; // current veya previous close
    this.priceCache.set(ck, price);
    return price;
  }

  // ── Quote (fiyat + değişim) ───────────────────────────────────────
  async getQuote(symbol) {
    const info = SYMBOL_MAP[symbol];
    if (!info) throw new Error(`Bilinmeyen sembol: ${symbol}`);

    const data = await this._get('/quote', { symbol: info.fh });
    return {
      price:     data.c,
      open:      data.o,
      high:      data.h,
      low:       data.l,
      prevClose: data.pc,
      change:    data.d,
      changePct: data.dp,
    };
  }

  // ── Mum verisi ───────────────────────────────────────────────────
  async getCandles(symbol, tf, limit = 120) {
    const ck = `candles_${symbol}_${tf}`;
    const cached = this.candleCache.get(ck);
    if (cached) return cached;

    const info       = SYMBOL_MAP[symbol];
    if (!info) throw new Error(`Bilinmeyen sembol: ${symbol}`);

    const resolution = RESOLUTION_MAP[tf] || '60';
    const to         = Math.floor(Date.now() / 1000);
    const rangeMap   = { '5':'3d', '15':'7d', '30':'14d', '60':'30d', '240':'90d', 'D':'365d' };
    const rangeDays  = parseInt(rangeMap[resolution] || '30d');
    const from       = to - rangeDays * 86400;

    const data = await this._get('/forex/candle', {
      symbol:     info.fh,
      resolution,
      from,
      to,
    });

    if (data.s === 'no_data' || !data.t?.length) {
      throw new Error('Veri yok');
    }

    const candles = data.t.map((time, i) => new Candle(
      time,
      data.o[i], data.h[i], data.l[i], data.c[i]
    ));

    // Son limit kadar al + duplicate temizle
    const seen   = new Set();
    const unique = candles.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    }).slice(-limit);

    this.candleCache.set(ck, unique);
    return unique;
  }

  // ── Tam piyasa verisi ─────────────────────────────────────────────
  async getMarketData(symbol, tf) {
    const candles    = await this.getCandles(symbol, tf);
    const indicators = IndicatorService.calculate(candles);
    const signal     = IndicatorService.deriveSignal(indicators);
    const last       = candles[candles.length - 1];
    const prev       = candles[candles.length - 2];

    // WebSocket'ten canlı fiyat varsa kullan
    const livePrice = this._livePrices.get(symbol);
    const price     = livePrice?.price || last.close;

    return {
      candles,
      indicators,
      signal,
      lastCandle: last,
      price,
      prevClose:  prev?.close,
      change:     prev ? parseFloat((price - prev.close).toFixed(8)) : 0,
      changePct:  prev ? parseFloat(((price - prev.close) / prev.close * 100).toFixed(4)) : 0,
    };
  }

  getLivePrices() { return this._livePrices; }

  stats() {
    return {
      requestCount: this.requestCount,
      wsConnected:  this._wsReady,
      livePrices:   this._livePrices.size,
      cache: {
        candles: this.candleCache.stats(),
        price:   this.priceCache.stats(),
      },
      recentErrors: this.errors.slice(-5),
    };
  }
}

module.exports = FinnhubService;
