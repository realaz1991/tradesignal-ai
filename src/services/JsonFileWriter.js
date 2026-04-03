'use strict';

const fs   = require('fs');
const path = require('path');

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

  _build() {
    const assets  = this.mdm.getFullSnapshot();
    const now     = new Date();
    const hour    = now.getUTCHours();
    const session = hour >= 13 ? 'New York' : hour >= 8 ? 'London' : 'Asian';

    const instruments = {};
    const top_signals = [];

    assets.forEach(a => {
      if (!a) return;

      // Her zaman dilimi için RSI + MACD + Sinyal
      const timeframes = {};
      Object.entries(a.timeframes || {}).forEach(([tf, d]) => {
        if (!d) return;

        const rsi  = d.indicators?.rsi        ?? null;
        const macd = d.indicators?.macd       ?? null;
        const sig  = d.indicators?.signal     ?? null;
        const hist = d.indicators?.histogram  ?? null;
        const stype = d.signal?.type  || 'wait';
        const slbl  = d.signal?.label || 'BEKLE';
        const sstr  = d.signal?.strength || 0;

        timeframes[tf] = {
          // ── İndikatörler ──
          rsi:       rsi  !== null ? parseFloat(rsi.toFixed(2))  : null,
          macd:      macd !== null ? parseFloat(macd.toFixed(6)) : null,
          macd_signal: sig  !== null ? parseFloat(sig.toFixed(6))  : null,
          histogram: hist !== null ? parseFloat(hist.toFixed(6)) : null,

          // ── RSI yorumu ──
          rsi_zone: rsi === null ? null
            : rsi > 70 ? 'Aşırı Alım (>70)'
            : rsi < 30 ? 'Aşırı Satım (<30)'
            : rsi > 50 ? 'Yükseliş Bölgesi (50-70)'
            : 'Düşüş Bölgesi (30-50)',

          // ── MACD yorumu ──
          macd_trend: hist === null ? null
            : hist > 0 ? 'Pozitif (yükseliş momentum)'
            : 'Negatif (düşüş momentum)',

          // ── Sinyal ──
          signal:          slbl,
          signal_type:     stype,
          signal_strength: sstr,
          signal_desc: stype === 'sbuy'  ? 'MACD AL kesişimi + RSI 50-70 — Güçlü alım'
                     : stype === 'buy'   ? 'MACD pozitif + RSI 50 üzeri — Alım'
                     : stype === 'ssell' ? 'MACD SAT kesişimi + RSI 30-50 — Güçlü satım'
                     : stype === 'sell'  ? 'MACD negatif + RSI 50 altı — Satım'
                     : 'Net sinyal yok — Bekle',
        };

        // Güçlü sinyalleri üst listeye ekle
        if (stype !== 'wait' && sstr >= 75) {
          top_signals.push({
            symbol:    a.symbol,
            price:     a.price,
            timeframe: tf,
            signal:    slbl,
            type:      stype,
            strength:  sstr,
            rsi:       rsi  !== null ? parseFloat(rsi.toFixed(2))  : null,
            macd:      macd !== null ? parseFloat(macd.toFixed(6)) : null,
            histogram: hist !== null ? parseFloat(hist.toFixed(6)) : null,
          });
        }
      });

      instruments[a.symbol] = {
        // ── Fiyat bilgisi ──
        price:      a.price      ?? null,
        change:     a.change     ?? 0,
        change_pct: parseFloat((a.changePct || 0).toFixed(3)),
        direction:  (a.changePct || 0) >= 0 ? 'up' : 'down',
        type:       a.type,

        // ── Tüm TF'lerde RSI + MACD + Sinyal ──
        timeframes,
      };
    });

    return {
      meta: {
        title:        'TradeSignal AI — Gerçek Zamanlı Forex & Emtia',
        source:       'scanme.az/forex',
        url:          'https://violet-hippopotamus-438533.hostingersite.com/data.json',
        updated:      now.toISOString(),
        next_update:  new Date(now.getTime() + 60000).toISOString(),
        market_session: session + ' Session',
        indicators:   'MACD(12,26,9) + RSI(14)',
        timeframes:   ['5min','15min','30min','1h','4h','1day'],
      },

      summary: assets
        .filter(a => a?.price)
        .map(a => `${a.symbol}: ${a.price} (${(a.changePct||0)>=0?'+':''}${(a.changePct||0).toFixed(2)}%)`)
        .join(' | '),

      instruments,

      top_signals: top_signals
        .sort((a, b) => (b.strength||0) - (a.strength||0))
        .slice(0, 10),
    };
  }
}

module.exports = JsonFileWriter;
