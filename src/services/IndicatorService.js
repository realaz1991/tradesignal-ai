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
