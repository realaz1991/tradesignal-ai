// services/MarketDataManager.js
'use strict';

const { AssetRegistry } = require('../models/Asset');
const FinnhubService    = require('./FinnhubService');
const IndicatorService  = require('./IndicatorService');

const TIMEFRAMES = ['5min','15min','1h','4h'];

// Refresh süreleri
const REFRESH_MS = {
  '5min':  5  * 60 * 1000,
  '15min': 15 * 60 * 1000,
  '30min': 30 * 60 * 1000,
  '1h':    60 * 60 * 1000,
  '4h':    4  * 60 * 60 * 1000,
  '1day':  24 * 60 * 60 * 1000,
};

class MarketDataManager {
  constructor(apiKey) {
    this.registry  = new AssetRegistry();
    this.tdService = new FinnhubService(apiKey);
    this._data     = new Map(); // symbol → tf → data
    this._intervals = new Map();
    this._listeners = new Map();
    this._loading   = new Set();
    console.log('[MarketDataManager] Initialized with', this.registry.getAll().length, 'assets');
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }
  emit(event, data) {
    (this._listeners.get(event) || []).forEach(fn => fn(data));
  }

  getMarketData(symbol, tf)  { return this._data.get(symbol)?.get(tf) || null; }
  getAllSignals(symbol) {
    const m = this._data.get(symbol);
    if (!m) return {};
    const r = {};
    m.forEach((d, tf) => { r[tf] = d.signal?.toJSON(); });
    return r;
  }

  getAssetSnapshot(symbol) {
    const asset = this.registry.get(symbol);
    if (!asset) return null;
    const tfMap = this._data.get(symbol) || new Map();
    const timeframes = {};
    TIMEFRAMES.forEach(tf => {
      const d = tfMap.get(tf);
      if (!d) return;
      timeframes[tf] = {
        signal:      d.signal?.toJSON(),
        indicators:  d.indicators?.toLatestJSON(),
        lastCandle:  d.candles?.[d.candles.length-1]?.toJSON(),
        candleCount: d.candles?.length,
      };
    });
    return { ...asset.toJSON(), timeframes };
  }

  getFullSnapshot() {
    return this.registry.getAll().map(a => this.getAssetSnapshot(a.symbol));
  }

  getChartData(symbol, tf, limit = 120) {
    const d = this.getMarketData(symbol, tf);
    if (!d?.candles) return null;
    const candles = d.candles.slice(-limit).map(c => c.toJSON());
    const ind = d.indicators;
    return {
      symbol, tf, candles,
      indicators: ind ? {
        rsi:       ind.rsi.slice(-limit),
        macd:      ind.macd.slice(-limit),
        signal:    ind.signal.slice(-limit),
        histogram: ind.histogram.slice(-limit),
      } : null,
      signal: d.signal?.toJSON(),
    };
  }

  async _fetchOne(asset, tf) {
    const key = `${asset.symbol}_${tf}`;
    if (this._loading.has(key)) return;
    this._loading.add(key);
    try {
      const data = await this.tdService.getMarketData(asset.symbol, tf);
      if (tf === '1h') asset.updatePrice(data.price, data.prevClose);
      if (!this._data.has(asset.symbol)) this._data.set(asset.symbol, new Map());
      this._data.get(asset.symbol).set(tf, data);
      this.emit('update', {
        type: 'candles', symbol: asset.symbol, tf,
        signal:     data.signal.toJSON(),
        indicators: data.indicators.toLatestJSON(),
        price:      asset.price,
        change:     asset.change,
        changePct:  asset.changePct,
      });
      console.log(`[MDM] ${asset.symbol} ${tf} — ${data.signal.label} RSI:${data.signal.rsi?.toFixed(1)}`);
    } catch(e) {
      // Rate limit veya API hatası — sessizce geç
      if (!e.message.includes('run out') && !e.message.includes('429')) {
        console.warn(`[MDM] Error ${asset.symbol} ${tf}: ${e.message}`);
      }
    } finally {
      this._loading.delete(key);
    }
  }

  async _fetchLivePrice(asset) {
    try {
      const quote = await this.tdService.getQuote(asset.symbol);
      asset.price     = quote.price;
      asset.open      = quote.open;
      asset.high      = quote.high;
      asset.low       = quote.low;
      asset.prevClose = quote.prevClose;
      asset.change    = quote.change;
      asset.changePct = quote.changePct;
      asset.updatedAt = Date.now();
      this.emit('price', {
        type: 'price', symbol: asset.symbol,
        price: asset.price, change: asset.change,
        changePct: asset.changePct, updatedAt: asset.updatedAt,
      });
    } catch {}
  }

  async start() {
    console.log('[MDM] Starting initial data load...');
    const assets = this.registry.getAll();

    // Finnhub WebSocket başlat
    this.tdService.connectWebSocket((symbol, price, ts) => {
      const asset = this.registry.get(symbol);
      if (!asset) return;
      const prev  = asset.price;
      asset.price = price; asset.updatedAt = ts;
      if (prev) {
        asset.change    = parseFloat((price - prev).toFixed(8));
        asset.changePct = parseFloat(((price - prev) / prev * 100).toFixed(4));
      }
      this.emit('price', {
        type: 'price', symbol: asset.symbol,
        price: asset.price, change: asset.change,
        changePct: asset.changePct, updatedAt: asset.updatedAt,
      });
    });

    // İlk yükleme — 4 TF: 1h → 4h → 15min → 5min
    for (const tf of ['1h','4h','15min','5min']) {
      for (const asset of assets) {
        await this._fetchOne(asset, tf);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    console.log('[MDM] Initial load complete. Starting refresh loops...');

    // Refresh döngüleri
    const REFRESH_MS = {
      '5min':  5  * 60 * 1000,
      '15min': 15 * 60 * 1000,
      '1h':    60 * 60 * 1000,
      '4h':    4  * 60 * 60 * 1000,
    };
    TIMEFRAMES.forEach(tf => {
      const id = setInterval(async () => {
        for (const asset of assets) {
          await this._fetchOne(asset, tf);
          await new Promise(r => setTimeout(r, 500));
        }
      }, REFRESH_MS[tf]);
      this._intervals.set(tf, id);
    });

    // Fiyat refresh — 30sn (Finnhub WS olmadığında fallback)
    const priceId = setInterval(async () => {
      for (const asset of assets) {
        await this._fetchLivePrice(asset);
        await new Promise(r => setTimeout(r, 200));
      }
    }, 30000);
    this._intervals.set('price', priceId);

    this.emit('ready', { message: 'MarketDataManager ready' });
    console.log('[MDM] All refresh loops active');
  }

  stop() {
    this._intervals.forEach((id, k) => { clearInterval(id); console.log('[MDM] Stopped', k); });
    this._intervals.clear();
  }

  stats() {
    return { assets: this.registry.getAll().length, loaded: this._data.size, api: this.tdService.stats() };
  }
}

module.exports = MarketDataManager;
