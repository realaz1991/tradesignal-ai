// services/IndicatorService.js
'use strict';

const { IndicatorResult, Signal } = require('../models/Candle');

class IndicatorService {
  /**
   * Exponential Moving Average
   */
  static ema(values, period) {
    const k = 2 / (period + 1);
    return values.reduce((acc, v, i) => {
      acc.push(i === 0 ? v : v * k + acc[i - 1] * (1 - k));
      return acc;
    }, []);
  }

  /**
   * RSI — Wilder's Smoothed Method
   */
  static calcRSI(closes, period = 14) {
    const rsi = new Array(closes.length).fill(null);
    for (let i = period; i < closes.length; i++) {
      const slice = closes.slice(i - period, i + 1);
      let gains = 0, losses = 0;
      for (let j = 1; j < slice.length; j++) {
        const diff = slice[j] - slice[j - 1];
        diff > 0 ? (gains += diff) : (losses -= diff);
      }
      if (losses === 0) { rsi[i] = 100; continue; }
      const rs = (gains / period) / (losses / period);
      rsi[i] = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
    }
    return rsi;
  }

  /**
   * MACD — Standard (12, 26, 9)
   */
  static calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const ema12 = IndicatorService.ema(closes, fastPeriod);
    const ema26 = IndicatorService.ema(closes, slowPeriod);
    const macd  = closes.map((_, i) => parseFloat((ema12[i] - ema26[i]).toFixed(8)));
    const signal = IndicatorService.ema(macd, signalPeriod);
    const histogram = macd.map((v, i) => parseFloat((v - signal[i]).toFixed(8)));
    return new IndicatorResult({ rsi: null, macd, signal, histogram });
  }

  /**
   * Full indicators from candle array
   */
  static calculate(candles) {
    const closes = candles.map(c => c.close);
    const rsi    = IndicatorService.calcRSI(closes);
    const macdResult = IndicatorService.calcMACD(closes);
    return new IndicatorResult({
      rsi,
      macd:      macdResult.macd,
      signal:    macdResult.signal,
      histogram: macdResult.histogram,
    });
  }

  /**
   * Derive trading signal from indicators
   * Rules:
   *   STRONG BUY:  MACD > Signal AND RSI 50–70
   *   STRONG SELL: MACD < Signal AND RSI 30–50
   *   BUY:         MACD > Signal AND RSI > 50
   *   SELL:        MACD < Signal AND RSI < 50
   *   WAIT:        otherwise
   */
  static deriveSignal(indicators) {
    const rsi  = indicators.latestRSI;
    if (rsi == null) return new Signal({ type:'wait', label:'BEKLE', strength:0 });

    const macdBull    = indicators.latestMACD > indicators.latestSig;
    const macdBear    = indicators.latestMACD < indicators.latestSig;
    const bullCross   = indicators.prevMACD < indicators.prevSig && indicators.latestMACD >= indicators.latestSig;
    const bearCross   = indicators.prevMACD > indicators.prevSig && indicators.latestMACD <= indicators.latestSig;

    if ((bullCross || macdBull) && rsi > 50 && rsi < 70) {
      return new Signal({ type:'sbuy',  label:'GÜÇLÜ AL',  strength: bullCross ? 95 : 80, rsi, macdCross: bullCross });
    }
    if ((bearCross || macdBear) && rsi < 50 && rsi > 30) {
      return new Signal({ type:'ssell', label:'GÜÇLÜ SAT', strength: bearCross ? 95 : 80, rsi, macdCross: bearCross });
    }
    if (macdBull && rsi > 50) {
      return new Signal({ type:'buy',   label:'AL',  strength:55, rsi });
    }
    if (macdBear && rsi < 50) {
      return new Signal({ type:'sell',  label:'SAT', strength:55, rsi });
    }
    return new Signal({ type:'wait', label:'BEKLE', strength:20, rsi });
  }
}

module.exports = IndicatorService;

// ─── RSI Seviye Analizi ───────────────────────────────────────────
// Tarihsel RSI verilerinden destek/direnç seviyeleri tespit eder
class RSILevelAnalyzer {

  /**
   * RSI dizisini analiz ederek önemli seviyeleri tespit eder
   * @param {number[]} rsiArr - Tarihsel RSI değerleri dizisi
   * @param {number[]} closes - Kapanış fiyatları (RSI tepelerine karşılık gelen fiyatlar)
   * @returns {object} - Tespit edilen RSI seviyeleri ve istatistikler
   */
  static analyze(rsiArr, closes = []) {
    const valid = rsiArr.filter(v => v !== null && !isNaN(v));
    if (valid.length < 20) return null;

    // ── 1. RSI tepe ve dip noktaları ─────────────────────────────
    const peaks   = []; // RSI tepeleri (yerel maksimum)
    const troughs = []; // RSI dipleri  (yerel minimum)

    for (let i = 2; i < valid.length - 2; i++) {
      const v = valid[i];
      // Tepe: sağ ve sol komşulardan büyük
      if (v > valid[i-1] && v > valid[i-2] && v > valid[i+1] && v > valid[i+2]) {
        peaks.push(v);
      }
      // Dip: sağ ve sol komşulardan küçük
      if (v < valid[i-1] && v < valid[i-2] && v < valid[i+1] && v < valid[i+2]) {
        troughs.push(v);
      }
    }

    // ── 2. RSI kümeleme analizi (hangi seviyelerde yoğunlaşıyor) ──
    const clusterPeaks   = this._findClusters(peaks,   3);
    const clusterTroughs = this._findClusters(troughs, 3);

    // ── 3. Standart seviyelerde test sayısı ───────────────────────
    const current = valid[valid.length - 1];
    const levels  = [30, 40, 50, 60, 70];
    const levelStats = {};

    levels.forEach(lvl => {
      const tolerance = 3; // ±3 RSI birimi
      const touches   = valid.filter(v => Math.abs(v - lvl) <= tolerance).length;
      const bounces   = this._countBounces(valid, lvl, tolerance);
      levelStats[lvl] = { touches, bounces, strength: Math.min(10, Math.round(bounces * 2)) };
    });

    // ── 4. Güncel durum analizi ───────────────────────────────────
    const trend      = this._trend(valid.slice(-14));
    const momentum   = this._momentum(valid);
    const divergence = this._divergence(valid, closes);

    // ── 5. Özel destek/direnç seviyeleri ─────────────────────────
    const resistance = this._topLevels(clusterPeaks,   'resistance');
    const support    = this._topLevels(clusterTroughs, 'support');

    return {
      // Mevcut RSI
      current: parseFloat(current.toFixed(2)),

      // Özel destek/direnç RSI seviyeleri
      resistance_levels: resistance,
      support_levels:    support,

      // Standart seviyelerin güçlülüğü (1-10)
      level_strength: levelStats,

      // Trend
      trend,       // 'yukselis' | 'dusus' | 'yatay'
      momentum,    // 'hizlaniyor' | 'yavazliyor' | 'stabil'
      divergence,  // 'bullish' | 'bearish' | null

      // İstatistikler
      stats: {
        avg:    parseFloat((valid.reduce((s,v)=>s+v,0)/valid.length).toFixed(2)),
        max:    parseFloat(Math.max(...valid).toFixed(2)),
        min:    parseFloat(Math.min(...valid).toFixed(2)),
        peak_count:   peaks.length,
        trough_count: troughs.length,
        bars_analyzed: valid.length,
      },

      // Yorum
      interpretation: this._interpret(current, resistance, support, trend, divergence),
    };
  }

  // Kümeleme — yakın değerleri grupla, merkezi bul
  static _findClusters(arr, tolerance = 3) {
    if (!arr.length) return [];
    const sorted = [...arr].sort((a,b) => a - b);
    const clusters = [];
    let group = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i-1] <= tolerance) {
        group.push(sorted[i]);
      } else {
        clusters.push(group);
        group = [sorted[i]];
      }
    }
    clusters.push(group);

    return clusters
      .filter(g => g.length >= 2) // en az 2 kez test edilmiş
      .map(g => ({
        level:  parseFloat((g.reduce((s,v)=>s+v,0)/g.length).toFixed(2)),
        hits:   g.length,
        range:  [parseFloat(Math.min(...g).toFixed(2)), parseFloat(Math.max(...g).toFixed(2))],
      }))
      .sort((a,b) => b.hits - a.hits);
  }

  // Belirli bir seviyeden kaç kez geri döndü
  static _countBounces(arr, level, tol) {
    let bounces = 0;
    for (let i = 1; i < arr.length - 1; i++) {
      const near = Math.abs(arr[i] - level) <= tol;
      if (!near) continue;
      // Yukarı geri dönüş (dip'ten)
      if (level <= 50 && arr[i+1] > arr[i] && arr[i-1] > arr[i]) bounces++;
      // Aşağı geri dönüş (tepeden)
      if (level >= 50 && arr[i+1] < arr[i] && arr[i-1] < arr[i]) bounces++;
    }
    return bounces;
  }

  // RSI trendi (son 14 bar)
  static _trend(arr) {
    if (arr.length < 5) return 'yatay';
    const first = arr.slice(0, Math.floor(arr.length/2)).reduce((s,v)=>s+v,0) / Math.floor(arr.length/2);
    const last  = arr.slice(Math.floor(arr.length/2)).reduce((s,v)=>s+v,0) / (arr.length - Math.floor(arr.length/2));
    const diff  = last - first;
    if (diff > 3)  return 'yukselis';
    if (diff < -3) return 'dusus';
    return 'yatay';
  }

  // RSI momentum
  static _momentum(arr) {
    const n = arr.length;
    if (n < 6) return 'stabil';
    const recent = arr.slice(-3).reduce((s,v)=>s+v,0) / 3;
    const prev   = arr.slice(-6,-3).reduce((s,v)=>s+v,0) / 3;
    const diff   = Math.abs(recent - prev);
    if (diff > 5) return recent > prev ? 'yukselis-hizlaniyor' : 'dusus-hizlaniyor';
    return 'stabil';
  }

  // Fiyat-RSI uyumsuzluğu (divergence)
  static _divergence(rsiArr, closes) {
    if (closes.length < 10 || rsiArr.length < 10) return null;
    const n = Math.min(rsiArr.length, closes.length, 20);
    const rRecent  = rsiArr.slice(-n);
    const cRecent  = closes.slice(-n);
    const rsiUp    = rRecent[n-1] > rRecent[0];
    const priceUp  = cRecent[n-1] > cRecent[0];
    if (!rsiUp && priceUp)  return 'bearish'; // fiyat yukari ama RSI asagi — dikkat
    if (rsiUp  && !priceUp) return 'bullish'; // fiyat asagi ama RSI yukari — toparlanma
    return null;
  }

  // En güçlü seviyeleri getir
  static _topLevels(clusters, type) {
    return clusters.slice(0, 3).map(c => ({
      ...c,
      type,
      note: type === 'resistance'
        ? `RSI ${c.level.toFixed(0)} seviyesi — ${c.hits} kez direnç yaptı`
        : `RSI ${c.level.toFixed(0)} seviyesi — ${c.hits} kez destek aldı`,
    }));
  }

  // Otomatik yorum
  static _interpret(current, resistance, support, trend, divergence) {
    const lines = [];

    if (current > 70) lines.push('⚠️ RSI aşırı alım bölgesinde (>70) — dikkatli olun');
    else if (current < 30) lines.push('⚠️ RSI aşırı satım bölgesinde (<30) — toparlanma beklenebilir');
    else if (current > 50) lines.push('✅ RSI yükseliş bölgesinde (50-70)');
    else lines.push('📉 RSI düşüş bölgesinde (30-50)');

    if (resistance.length > 0) {
      const nearest = resistance.find(r => r.level > current);
      if (nearest) lines.push(`🔴 Yakın RSI direnci: ${nearest.level.toFixed(0)} (${nearest.hits} kez test edildi)`);
    }
    if (support.length > 0) {
      const nearest = support.find(s => s.level < current);
      if (nearest) lines.push(`🟢 Yakın RSI desteği: ${nearest.level.toFixed(0)} (${nearest.hits} kez test edildi)`);
    }

    if (trend === 'yukselis') lines.push('📈 RSI yükseliş trendi izliyor');
    else if (trend === 'dusus') lines.push('📉 RSI düşüş trendi izliyor');

    if (divergence === 'bearish') lines.push('⚡ Bearish divergence — fiyat yükseliyor ama RSI düşüyor');
    if (divergence === 'bullish') lines.push('⚡ Bullish divergence — fiyat düşüyor ama RSI yükseliyor');

    return lines;
  }
}

module.exports.RSILevelAnalyzer = RSILevelAnalyzer;
