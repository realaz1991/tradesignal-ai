'use strict';

const fs   = require('fs');
const path = require('path');
const { RSILevelAnalyzer } = require('./IndicatorService');

const OUTPUT_FILE = path.join(__dirname, '../../public/data.json');
const TIMEFRAMES  = ['5min', '15min', '1h', '4h'];

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
      const json = JSON.stringify(this._build(), null, 2);
      fs.writeFileSync(OUTPUT_FILE, json, 'utf8');
      console.log('[JsonWriter] data.json güncellendi —', new Date().toISOString());
    } catch(e) {
      console.warn('[JsonWriter] Hata:', e.message);
    } finally {
      this._writing = false;
    }
  }

  _r(v, dec = 5) {
    if (v == null || isNaN(v)) return null;
    return parseFloat(Number(v).toFixed(dec));
  }

  _build() {
    const now     = new Date();
    const hour    = now.getUTCHours();
    const session = hour >= 13 ? 'New York' : hour >= 8 ? 'London' : 'Asian';

    const instruments = {};
    const top_signals = [];
    const assets = this.mdm.registry.getAll();

    assets.forEach(asset => {
      const sym   = asset.symbol;
      const tfMap = this.mdm._data.get(sym) || new Map();

      // ── Her 4 TF için RSI + MACD + Sinyal ──────────────────────
      const timeframes = {};

      TIMEFRAMES.forEach(tf => {
        const d = tfMap.get(tf);

        if (!d || !d.indicators) {
          // Veri henüz yüklenmemiş
          timeframes[tf] = {
            status:    'yukleniyor',
            rsi:       null,
            macd:      null,
            histogram: null,
            signal:    'BEKLE',
            signal_type: 'wait',
            signal_strength: 0,
          };
          return;
        }

        const ind  = d.indicators;  // IndicatorResult instance
        const sig  = d.signal;      // Signal instance

        // ── RSI ──────────────────────────────────────────────────
        const rsiVal  = this._r(ind.latestRSI,  2);

        // ── MACD ─────────────────────────────────────────────────
        const macdVal = this._r(ind.latestMACD, 6);
        const sigVal  = this._r(ind.latestSig,  6);
        const histVal = this._r(ind.latestHist, 6);

        // ── Sinyal ───────────────────────────────────────────────
        const stype = sig?.type     || 'wait';
        const slbl  = sig?.label    || 'BEKLE';
        const sstr  = sig?.strength || 0;

        // ── RSI Seviye Analizi ───────────────────────────────────
        let rsiAnalysis = null;
        if (ind.rsi && ind.rsi.filter(v=>v!==null).length > 20) {
          const closes = d.candles?.map(c => c.close) || [];
          rsiAnalysis = RSILevelAnalyzer.analyze(ind.rsi, closes);
        }

        timeframes[tf] = {
          status: 'aktif',

          // ── RSI ──
          rsi:       rsiVal,
          rsi_zone:  rsiVal === null ? null
            : rsiVal > 70 ? 'Asiri Alim (>70)'
            : rsiVal < 30 ? 'Asiri Satim (<30)'
            : rsiVal > 50 ? 'Yukselis Bolgesi (50-70)'
            : 'Dusus Bolgesi (30-50)',

          // ── MACD ──
          macd:         macdVal,
          macd_signal:  sigVal,
          histogram:    histVal,
          macd_trend:   histVal === null ? null
            : histVal > 0 ? 'Pozitif (yukselis momentum)'
            : 'Negatif (dusus momentum)',

          // ── Sinyal ──
          signal:          slbl,
          signal_type:     stype,
          signal_strength: sstr,
          signal_desc:
            stype === 'sbuy'  ? 'MACD AL kesisimi + RSI 50-70 — Guclu AL'
          : stype === 'buy'   ? 'MACD pozitif + RSI 50 uzeri — AL'
          : stype === 'ssell' ? 'MACD SAT kesisimi + RSI 30-50 — Guclu SAT'
          : stype === 'sell'  ? 'MACD negatif + RSI 50 alti — SAT'
          : 'Net sinyal yok — BEKLE',

          // ── RSI Tarihsel Seviye Analizi ──
          rsi_analysis: rsiAnalysis ? {
            trend:             rsiAnalysis.trend,
            momentum:          rsiAnalysis.momentum,
            divergence:        rsiAnalysis.divergence,
            resistance_levels: rsiAnalysis.resistance_levels,
            support_levels:    rsiAnalysis.support_levels,
            interpretation:    rsiAnalysis.interpretation,
            stats:             rsiAnalysis.stats,
          } : null,
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
            rsi:       rsiVal,
            macd:      macdVal,
            histogram: histVal,
          });
        }
      });

      instruments[sym] = {
        price:      asset.price      ?? null,
        change:     this._r(asset.change, 5),
        change_pct: this._r(asset.changePct, 3),
        direction:  (asset.changePct || 0) >= 0 ? 'up' : 'down',
        type:       asset.type,
        timeframes,
      };
    });

    // ── Özet metin ───────────────────────────────────────────────
    const summary = assets
      .filter(a => a?.price)
      .map(a => {
        const pct = (a.changePct||0).toFixed(2);
        return `${a.symbol}: ${a.price} (${a.changePct>=0?'+':''}${pct}%)`;
      })
      .join(' | ');

    return {
      meta: {
        title:          'TradeSignal AI — Gercek Zamanli Forex & Emtia',
        source:         'scanme.az/forex',
        url:            'https://violet-hippopotamus-438533.hostingersite.com/data.json',
        updated:        now.toISOString(),
        next_update:    new Date(now.getTime() + 60000).toISOString(),
        market_session: session + ' Session',
        timeframes:     TIMEFRAMES,
        indicators:     'RSI(14) + MACD(12,26,9)',
        instruments_count: assets.length,
      },

      summary,

      instruments,

      top_signals: top_signals
        .sort((a,b) => (b.strength||0) - (a.strength||0))
        .slice(0, 10),

      // AI'lar için rehber
      guide: {
        timeframes: {
          '5min':  '5 dakikalik — kisa vadeli scalping',
          '15min': '15 dakikalik — gun ici islem',
          '1h':    '1 saatlik — orta vadeli',
          '4h':    '4 saatlik — swing trade',
        },
        signals: {
          'GUCLU AL':  'MACD AL kesisimi + RSI 50-70 — yuksek guvenilirlik',
          'AL':        'MACD pozitif + RSI 50 uzeri',
          'GUCLU SAT': 'MACD SAT kesisimi + RSI 30-50 — yuksek guvenilirlik',
          'SAT':       'MACD negatif + RSI 50 alti',
          'BEKLE':     'Net sinyal yok',
        },
      },
    };
  }
}

module.exports = JsonFileWriter;
