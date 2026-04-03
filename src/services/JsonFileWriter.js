// services/JsonFileWriter.js
// Her dakika guncel piyasa verisini public/data.json dosyasina yazar
// AI'lar, botlar, herkes okuyabilir — statik dosya gibi servis edilir
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
    // Hemen yaz, sonra her dakika yenile
    this.write();
    this._timer = setInterval(() => this.write(), intervalMs);
    console.log('[JsonWriter] Başladı — her', intervalMs/1000, 'saniyede güncellenir');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  write() {
    if (this._writing) return;
    this._writing = true;
    try {
      const data = this._buildData();
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
      console.log('[JsonWriter] data.json güncellendi —', new Date().toISOString());
    } catch(e) {
      console.warn('[JsonWriter] Yazma hatası:', e.message);
    } finally {
      this._writing = false;
    }
  }

  _buildData() {
    const assets  = this.mdm.getFullSnapshot();
    const now     = new Date();
    const hour    = now.getUTCHours();
    const session = hour >= 13 ? 'New York' : hour >= 8 ? 'London' : 'Asian';

    const prices  = {};
    const signals = [];

    assets.forEach(a => {
      if (!a) return;

      // Fiyat bilgisi
      prices[a.symbol] = {
        price:      a.price      || null,
        change:     a.change     || 0,
        change_pct: a.changePct  || 0,
        direction:  (a.changePct||0) >= 0 ? 'up' : 'down',
        type:       a.type,
      };

      // Sinyal bilgisi — tüm TF'ler
      const tfSignals = {};
      Object.entries(a.timeframes || {}).forEach(([tf, d]) => {
        if (!d?.signal) return;
        tfSignals[tf] = {
          signal:    d.signal.label,
          type:      d.signal.type,
          strength:  d.signal.strength,
          rsi:       d.indicators?.rsi    || null,
          macd:      d.indicators?.macd   || null,
          histogram: d.indicators?.histogram || null,
        };

        // Güçlü sinyalleri listeye ekle
        if (d.signal.type !== 'wait' && d.signal.strength >= 75) {
          signals.push({
            symbol:    a.symbol,
            price:     a.price,
            timeframe: tf,
            signal:    d.signal.label,
            type:      d.signal.type,
            strength:  d.signal.strength,
            rsi:       d.indicators?.rsi,
          });
        }
      });

      prices[a.symbol].signals = tfSignals;
    });

    return {
      // ── Meta bilgi ─────────────────────────────────────────────
      meta: {
        title:       'TradeSignal AI — Gerçek Zamanlı Forex & Emtia Verileri',
        source:      'scanme.az/forex',
        api:         'https://violet-hippopotamus-438533.hostingersite.com/data.json',
        updated:     now.toISOString(),
        updated_ts:  now.getTime(),
        next_update: new Date(now.getTime() + 60000).toISOString(),
        market_session: session + ' Session',
        data_source: 'Finnhub (fiyat) + Twelve Data (mum)',
        indicators:  'MACD(12,26,9) + RSI(14)',
      },

      // ── Özet metin (AI için okunabilir) ────────────────────────
      summary: assets
        .filter(a => a?.price)
        .map(a => `${a.symbol}: ${a.price} (${(a.changePct||0) >= 0 ? '+' : ''}${(a.changePct||0).toFixed(2)}%)`)
        .join(' | '),

      // ── Tüm fiyatlar ve sinyaller ───────────────────────────────
      prices,

      // ── En güçlü sinyaller ──────────────────────────────────────
      top_signals: signals
        .sort((a, b) => (b.strength||0) - (a.strength||0))
        .slice(0, 10),

      // ── Sinyal açıklaması (AI için) ────────────────────────────
      signal_guide: {
        'GÜÇLÜ AL':  'MACD AL kesişimi + RSI 50-70 arası — yüksek güvenilirlik',
        'AL':        'MACD pozitif + RSI 50 üzeri',
        'GÜÇLÜ SAT': 'MACD SAT kesişimi + RSI 30-50 arası — yüksek güvenilirlik',
        'SAT':       'MACD negatif + RSI 50 altı',
        'BEKLE':     'Net sinyal yok',
      },
    };
  }
}

module.exports = JsonFileWriter;
