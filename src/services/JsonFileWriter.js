'use strict';

const fs   = require('fs');
const path = require('path');
const { RSILevelAnalyzer } = require('./IndicatorService');

const OUTPUT_FILE = path.join(__dirname, '../../public/data.json');

class JsonFileWriter {
  constructor(mdm) {
    this.mdm      = mdm;
    this._timer   = null;
    this._writing = false;
  }

  start(intervalMs = 60000) {
    this.write();
    this._timer = setInterval(() => this.write(), intervalMs);
    console.log('[JsonWriter] Başladı — her', intervalMs / 1000, 'saniyede güncellenir');
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  write() {
    if (this._writing) return;
    this._writing = true;
    try {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(this._build(), null, 2), 'utf8');
      console.log('[JsonWriter] data.json güncellendi —', new Date().toISOString());
    } catch(e) {
      console.warn('[JsonWriter] Hata:', e.message);
    } finally {
      this._writing = false;
    }
  }

  // Sayıyı belirli ondalık basamağa yuvarla, null ise null döndür
  _round(v, dec = 5) {
    if (v == null || isNaN(v)) return null;
    return parseFloat(Number(v).toFixed(dec));
  }

  _build() {
    const now     = new Date();
    const hour    = now.getUTCHours();
    const session = hour >= 13 ? 'New York' : hour >= 8 ? 'London' : 'Asian';

    const instruments = {};
    const top_signals = [];

    // _data map'inden direkt oku — snapshot üzerinden değil
    const assets = this.mdm.registry.getAll();

    assets.forEach(asset => {
      const sym    = asset.symbol;
      const tfMap  = this.mdm._data.get(sym) || new Map();
      const timeframes = {};

      tfMap.forEach((d, tf) => {
        if (!d) return;

        // ── IndicatorResult objesinden son değerleri al ──
        const ind  = d.indicators;   // IndicatorResult instance
        const sig  = d.signal;       // Signal instance

        // ind.latestRSI, ind.latestMACD vb. getter'ları kullan
        const rsiV  = ind ? this._round(ind.latestRSI,  2) : null;
        const macdV = ind ? this._round(ind.latestMACD, 6) : null;
        const sigV  = ind ? this._round(ind.latestSig,  6) : null;
        const histV = ind ? this._round(ind.latestHist, 6) : null;

        const stype = sig?.type     || 'wait';
        const slbl  = sig?.label    || 'BEKLE';
        const sstr  = sig?.strength || 0;
        const srsi  = sig?.rsi      || rsiV;

        // RSI seviye analizi — tarihsel RSI'dan destek/direnç seviyeleri
        const rsiAnalysis = ind?.rsi?.length > 20
          ? RSILevelAnalyzer.analyze(ind.rsi, d.candles?.map(c => c.close) || [])
          : null;

        timeframes[tf] = {
          // İndikatör değerleri
          rsi:          rsiV,
          macd:         macdV,
          macd_signal:  sigV,
          histogram:    histV,

          // RSI yorumu
          rsi_zone: rsiV === null ? null
            : rsiV > 70 ? 'Aşırı Alım (>70)'
            : rsiV < 30 ? 'Aşırı Satım (<30)'
            : rsiV > 50 ? 'Yükseliş Bölgesi (50-70)'
            : 'Düşüş Bölgesi (30-50)',

          // MACD yorumu
          macd_trend: histV === null ? null
            : histV > 0 ? 'Pozitif (yükseliş momentum)'
            : 'Negatif (düşüş momentum)',

          // Sinyal
          signal:          slbl,
          signal_type:     stype,
          signal_strength: sstr,
          signal_desc:
            stype === 'sbuy'  ? 'MACD AL kesişimi + RSI 50-70 — Güçlü AL'
          : stype === 'buy'   ? 'MACD pozitif + RSI 50 üzeri — AL'
          : stype === 'ssell' ? 'MACD SAT kesişimi + RSI 30-50 — Güçlü SAT'
          : stype === 'sell'  ? 'MACD negatif + RSI 50 altı — SAT'
          : 'Net sinyal yok — BEKLE',

          // RSI seviye analizi
          rsi_analysis: rsiAnalysis,
        };

        // Güçlü sinyalleri listeye ekle
        if (stype !== 'wait' && sstr >= 75) {
          top_signals.push({
            symbol:    sym,
            price:     asset.price,
            timeframe: tf,
            signal:    slbl,
            type:      stype,
            strength:  sstr,
            rsi:       rsiV,
            macd:      macdV,
            histogram: histV,
          });
        }
      });

      instruments[sym] = {
        price:      asset.price      ?? null,
        change:     this._round(asset.change,    5),
        change_pct: this._round(asset.changePct, 3),
        direction:  (asset.changePct || 0) >= 0 ? 'up' : 'down',
        type:       asset.type,
        timeframes,
      };
    });

    return {
      meta: {
        title:          'TradeSignal AI — Gerçek Zamanlı Forex & Emtia',
        source:         'scanme.az/forex',
        url:            'https://violet-hippopotamus-438533.hostingersite.com/data.json',
        updated:        now.toISOString(),
        next_update:    new Date(now.getTime() + 60000).toISOString(),
        market_session: session + ' Session',
        indicators:     'MACD(12,26,9) + RSI(14)',
        timeframes:     ['5min','15min','30min','1h','4h','1day'],
      },

      summary: assets
        .filter(a => a?.price)
        .map(a => `${a.symbol}: ${a.price} (${(a.changePct||0) >= 0 ? '+' : ''}${(a.changePct||0).toFixed(2)}%)`)
        .join(' | '),

      instruments,

      top_signals: top_signals
        .sort((a, b) => (b.strength||0) - (a.strength||0))
        .slice(0, 10),
    };
  }
}

module.exports = JsonFileWriter;
