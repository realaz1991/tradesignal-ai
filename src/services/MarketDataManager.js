// services/MarketDataManager.js
'use strict';

const { AssetRegistry } = require('../models/Asset');
const TwelveDataService = require('./TwelveDataService');
const IndicatorService  = require('./IndicatorService');

const TIMEFRAMES = ['5min', '15min', '30min', '1h', '4h', '1day'];

class MarketDataManager {
  constructor(apiKey) {
    this.registry  = new AssetRegistry();
    this.tdService = new TwelveDataService(apiKey);

    // symbol → tf → { candles, indicators, signal }
    this._marketData = new Map();

    // Refresh intervals
    this._intervals = new Map();
    this._refreshing = new Set();

    // Event listeners
    this._listeners = new Map(); // event → [fn]

    console.log('[MarketDataManager] Initialized with', this.registry.getAll().length, 'assets');
  }

  // ── Event Bus ────────────────────────────────────────────────────
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }

  emit(event, data) {
    (this._listeners.get(event) || []).forEach(fn => fn(data));
  }

  // ── Data Access ──────────────────────────────────────────────────
  getMarketData(symbol, tf) {
    return this._marketData.get(symbol)?.get(tf) || null;
  }

  getAllSignals(symbol) {
    const tfMap = this._marketData.get(symbol);
    if (!tfMap) return {};
    const result = {};
    tfMap.forEach((data, tf) => { result[tf] = data.signal?.toJSON(); });
    return result;
  }

  getAssetSnapshot(symbol) {
    const asset = this.registry.get(symbol);
    if (!asset) return null;
    const tfMap = this._marketData.get(symbol) || new Map();
    const timeframes = {};
    TIMEFRAMES.forEach(tf => {
      const d = tfMap.get(tf);
      if (!d) return;
      timeframes[tf] = {
        signal:     d.signal?.toJSON(),
        indicators: d.indicators?.toLatestJSON(),
        lastCandle: d.candles?.[d.candles.length - 1]?.toJSON(),
        candleCount: d.candles?.length,
      };
    });
    return { ...asset.toJSON(), timeframes };
  }

  getFullSnapshot() {
    return this.registry.getAll().map(a => this.getAssetSnapshot(a.symbol));
  }

  // ── Candle data for chart (latest N candles) ─────────────────────
  getChartData(symbol, tf, limit = 120) {
    const d = this.getMarketData(symbol, tf);
    if (!d?.candles) return null;
    const candles = d.candles.slice(-limit).map(c => c.toJSON());
    const ind = d.indicators;
    return {
      symbol, tf,
      candles,
      indicators: ind ? {
        rsi:       ind.rsi.slice(-limit),
        macd:      ind.macd.slice(-limit),
        signal:    ind.signal.slice(-limit),
        histogram: ind.histogram.slice(-limit),
      } : null,
      signal: d.signal?.toJSON(),
    };
  }

  // ── Fetch & store ────────────────────────────────────────────────
  async _fetchAssetTF(asset, tf) {
    const key = `${asset.symbol}_${tf}`;
    if (this._refreshing.has(key)) return;
    this._refreshing.add(key);
    try {
      const data = await this.tdService.getMarketData(asset.tdSymbol, tf);

      // Update asset live price from 1h (balanced frequency)
      if (tf === '1h') {
        asset.updatePrice(data.price, data.prevClose);
      }

      // Store
      if (!this._marketData.has(asset.symbol)) this._marketData.set(asset.symbol, new Map());
      this._marketData.get(asset.symbol).set(tf, data);

      // Emit update
      this.emit('update', {
        type:   'candles',
        symbol: asset.symbol,
        tf,
        signal: data.signal.toJSON(),
        indicators: data.indicators.toLatestJSON(),
        price:  asset.price,
        change: asset.change,
        changePct: asset.changePct,
      });

      console.log(`[MDM] ${asset.symbol} ${tf} — ${data.signal.label} RSI:${data.signal.rsi?.toFixed(1)}`);
    } catch (e) {
      console.warn(`[MDM] Error ${asset.symbol} ${tf}: ${e.message}`);
      this.emit('error', { symbol: asset.symbol, tf, error: e.message });
    } finally {
      this._refreshing.delete(key);
    }
  }

  // Fetch live price only (lightweight, fast)
  async _fetchLivePrice(asset) {
    try {
      const quote = await this.tdService.getQuote(asset.tdSymbol);
      asset.price     = quote.price;
      asset.open      = quote.open;
      asset.high      = quote.high;
      asset.low       = quote.low;
      asset.prevClose = quote.prevClose;
      asset.change    = quote.change;
      asset.changePct = quote.changePct;
      asset.updatedAt = Date.now();

      this.emit('price', {
        type:      'price',
        symbol:    asset.symbol,
        price:     asset.price,
        open:      asset.open,
        high:      asset.high,
        low:       asset.low,
        change:    asset.change,
        changePct: asset.changePct,
        updatedAt: asset.updatedAt,
      });
    } catch (e) {
      // Silently ignore price fetch errors (non-critical)
    }
  }

  // ── Start ─────────────────────────────────────────────────────────
  async start() {
    console.log('[MDM] Starting initial data load...');

    const assets = this.registry.getAll();

    // Phase 1: Load all timeframes for all assets (staggered)
    for (const asset of assets) {
      for (const tf of TIMEFRAMES) {
        await this._fetchAssetTF(asset, tf);
        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log('[MDM] Initial load complete. Starting refresh loops...');

    // Phase 2: Periodic refresh per TF
    const refreshIntervals = {
      '5min':  5  * 60 * 1000,
      '15min': 15 * 60 * 1000,
      '30min': 30 * 60 * 1000,
      '1h':    60 * 60 * 1000,
      '4h':    4  * 60 * 60 * 1000,
      '1day':  24 * 60 * 60 * 1000,
    };

    TIMEFRAMES.forEach(tf => {
      const interval = refreshIntervals[tf];
      const id = setInterval(async () => {
        for (const asset of assets) {
          await this._fetchAssetTF(asset, tf);
          await new Promise(r => setTimeout(r, 300));
        }
      }, interval);
      this._intervals.set(tf, id);
    });

    // Phase 3: Live price refresh every 15 seconds
    const priceId = setInterval(async () => {
      for (const asset of assets) {
        await this._fetchLivePrice(asset);
        await new Promise(r => setTimeout(r, 200));
      }
    }, 15000);
    this._intervals.set('price', priceId);

    this.emit('ready', { message: 'MarketDataManager ready', assets: assets.length });
    console.log('[MDM] All refresh loops active');
  }

  stop() {
    this._intervals.forEach((id, key) => { clearInterval(id); console.log(`[MDM] Stopped ${key} interval`); });
    this._intervals.clear();
  }

  stats() {
    return {
      assets: this.registry.getAll().length,
      loaded: this._marketData.size,
      api:    this.tdService.stats(),
    };
  }
}

module.exports = MarketDataManager;
