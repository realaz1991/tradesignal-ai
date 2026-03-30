// models/Candle.js
'use strict';

class Candle {
  constructor(time, open, high, low, close) {
    this.time  = typeof time === 'number' ? time : Math.floor(new Date(time.replace(' ','T')+'Z').getTime()/1000);
    this.open  = parseFloat(open);
    this.high  = parseFloat(high);
    this.low   = parseFloat(low);
    this.close = parseFloat(close);
  }

  toJSON() {
    return { time: this.time, open: this.open, high: this.high, low: this.low, close: this.close };
  }
}

// ─── Indicators ───────────────────────────────────────────────────
class IndicatorResult {
  constructor({ rsi, macd, signal, histogram }) {
    this.rsi       = rsi;
    this.macd      = macd;
    this.signal    = signal;
    this.histogram = histogram;
  }

  // Latest values
  get latestRSI()  { return this.rsi[this.rsi.length - 1]; }
  get latestMACD() { return this.macd[this.macd.length - 1]; }
  get latestSig()  { return this.signal[this.signal.length - 1]; }
  get latestHist() { return this.histogram[this.histogram.length - 1]; }
  get prevHist()   { return this.histogram[this.histogram.length - 2]; }
  get prevMACD()   { return this.macd[this.macd.length - 2]; }
  get prevSig()    { return this.signal[this.signal.length - 2]; }

  toLatestJSON() {
    return {
      rsi:       this.latestRSI,
      macd:      this.latestMACD,
      signal:    this.latestSig,
      histogram: this.latestHist,
    };
  }

  toFullJSON() {
    return {
      rsi:       this.rsi,
      macd:      this.macd,
      signal:    this.signal,
      histogram: this.histogram,
    };
  }
}

// ─── Signal ───────────────────────────────────────────────────────
class Signal {
  static TYPES = {
    STRONG_BUY:  'sbuy',
    BUY:         'buy',
    STRONG_SELL: 'ssell',
    SELL:        'sell',
    WAIT:        'wait',
  };

  constructor({ type, label, strength, rsi, macdCross = false }) {
    this.type      = type;
    this.label     = label;
    this.strength  = strength;
    this.rsi       = rsi;
    this.macdCross = macdCross;
    this.timestamp = Date.now();
  }

  get isBullish() { return this.type === 'sbuy' || this.type === 'buy'; }
  get isBearish() { return this.type === 'ssell' || this.type === 'sell'; }
  get isStrong()  { return this.type === 'sbuy' || this.type === 'ssell'; }
  get isWait()    { return this.type === 'wait'; }

  toJSON() {
    return {
      type:      this.type,
      label:     this.label,
      strength:  this.strength,
      rsi:       this.rsi,
      macdCross: this.macdCross,
      timestamp: this.timestamp,
    };
  }
}

module.exports = { Candle, IndicatorResult, Signal };
