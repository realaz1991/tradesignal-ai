// routes/api.js
'use strict';

const express = require('express');

function createRouter(mdm) {
  const router = express.Router();

  // ── /api/prices — AI'lar için optimize edilmiş fiyat endpoint'i ──
  // ChatGPT, Perplexity, Gemini, Claude bu endpoint'i okur
  router.get('/prices', (req, res) => {
    const assets  = mdm.getFullSnapshot();
    const updated = new Date().toISOString();

    // Düz, AI'ın kolayca okuyabileceği format
    const prices = {};
    assets.forEach(a => {
      if (!a || !a.price) return;
      prices[a.symbol] = {
        price:      a.price,
        change:     a.change,
        change_pct: a.changePct,
        updated_at: a.updatedAt ? new Date(a.updatedAt).toISOString() : updated,
      };
    });

    res.json({
      source:      'TradeSignal AI — scanme.az/forex',
      description: 'Real-time forex and commodity prices',
      updated:     updated,
      instruments: prices,
      note: 'Prices updated every 60 seconds from live market feeds',
    });
  });

  // ── /api/signals — Sinyal endpoint'i ─────────────────────────────
  router.get('/signals', (req, res) => {
    const tf      = req.query.tf || '1h';
    const assets  = mdm.registry.getAll();
    const updated = new Date().toISOString();
    const signals = {};

    assets.forEach(asset => {
      const lp  = mdm.registry.get(asset.symbol);
      const sig = mdm.getAllSignals(asset.symbol);
      signals[asset.symbol] = {
        price:    lp?.price,
        signals:  sig,
        best_signal: Object.values(sig).reduce((best, s) => {
          if (!best || (s?.strength || 0) > (best?.strength || 0)) return s;
          return best;
        }, null),
      };
    });

    res.json({
      source:      'TradeSignal AI — scanme.az/forex',
      description: 'MACD + RSI trading signals for forex and commodities',
      timeframe:   tf,
      updated:     updated,
      signals,
      signal_types: {
        sbuy:  'Strong Buy — MACD bullish cross + RSI 50-70',
        buy:   'Buy — MACD positive + RSI > 50',
        ssell: 'Strong Sell — MACD bearish cross + RSI 30-50',
        sell:  'Sell — MACD negative + RSI < 50',
        wait:  'Wait — No clear signal',
      },
    });
  });

  // ── /api/market-data — Tam piyasa verisi (AI için zengin format) ──
  router.get('/market-data', (req, res) => {
    const assets  = mdm.getFullSnapshot();
    const updated = new Date().toISOString();

    const data = assets.map(a => {
      if (!a) return null;
      // En güçlü sinyali bul
      const allSigs = Object.entries(a.timeframes || {}).map(([tf, d]) => ({
        tf, ...d?.signal
      }));
      const bestSig = allSigs.reduce((b, s) => (!b || (s?.strength||0) > (b?.strength||0)) ? s : b, null);

      return {
        symbol:      a.symbol,
        type:        a.type,
        price:       a.price,
        change:      a.change,
        change_pct:  a.changePct,
        best_signal: bestSig ? {
          timeframe: bestSig.tf,
          type:      bestSig.type,
          label:     bestSig.label,
          strength:  bestSig.strength,
          rsi:       bestSig.rsi,
        } : null,
        signals_by_timeframe: Object.fromEntries(
          Object.entries(a.timeframes || {}).map(([tf, d]) => [tf, {
            signal:     d?.signal?.label,
            strength:   d?.signal?.strength,
            rsi:        d?.indicators?.rsi,
            macd:       d?.indicators?.macd,
          }])
        ),
      };
    }).filter(Boolean);

    res.json({
      source:      'TradeSignal AI',
      website:     'https://scanme.az/forex',
      description: 'Real-time forex and commodity market data with MACD+RSI signals',
      updated,
      count:       data.length,
      data,
    });
  });

  // ── /api/assets ───────────────────────────────────────────────────
  router.get('/assets', (req, res) => {
    res.json({ ok: true, data: mdm.getFullSnapshot(), ts: Date.now() });
  });

  // ── /api/asset/:symbol ────────────────────────────────────────────
  router.get('/asset/:symbol', (req, res) => {
    const data = mdm.getAssetSnapshot(decodeURIComponent(req.params.symbol));
    if (!data) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // ── /api/chart/:symbol/:tf ────────────────────────────────────────
  router.get('/chart/:symbol/:tf', (req, res) => {
    const data = mdm.getChartData(
      decodeURIComponent(req.params.symbol),
      req.params.tf,
      parseInt(req.query.limit) || 120
    );
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // ── /api/ai/analyze ───────────────────────────────────────────────
  router.post('/ai/analyze', async (req, res) => {
    const { symbol, tf, price, changePct, signal, rsi } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ ok: false, text: 'Anthropic API key eksik.', score: 0 });
    }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Forex analist. ${symbol} için Türkçe kısa analiz:
Zaman: ${tf} | Fiyat değişim: ${changePct}%
Sinyal: ${signal?.label} (${signal?.strength}%) | RSI: ${rsi}
3-4 cümle: görünüm, güven/risk, push bildirim verilmeli mi? Professional Türkçe.`
          }]
        })
      });
      const data = await response.json();
      const text = data.content?.[0]?.text || 'Yanıt alınamadı.';
      res.json({ ok: true, text, score: signal?.strength || 0 });
    } catch (e) {
      res.json({ ok: false, text: 'AI bağlantı hatası: ' + e.message, score: 0 });
    }
  });

  // ── /api/ai/check ─────────────────────────────────────────────────
  router.post('/ai/check', async (req, res) => {
    const { symbol, tf, signal, rsi, changePct } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({
        ok: true,
        approved: (signal?.strength || 0) >= 75,
        score: signal?.strength || 0,
        verdict: (signal?.strength || 0) >= 75 ? 'Onaylandı' : 'Dikkatli',
        shortNote: 'Kural bazlı karar',
        reason: 'API key yok'
      });
    }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `Sadece JSON döndür:
{"approved":bool,"score":0-100,"verdict":"Onaylandı/Dikkatli/Bloklandı","shortNote":"max 5 kelime","reason":"max 10 kelime"}
Varlık:${symbol} TF:${tf} Sinyal:${signal?.label}(${signal?.strength}%) RSI:${rsi} Değişim:${changePct}%`
          }]
        })
      });
      const data = await response.json();
      const text = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
      const result = JSON.parse(text);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.json({
        ok: true,
        approved: (signal?.strength || 0) >= 75,
        score: signal?.strength || 0,
        verdict: 'Dikkatli',
        shortNote: 'AI yanıt vermedi',
        reason: e.message
      });
    }
  });

  // ── /api/stats ────────────────────────────────────────────────────
  router.get('/stats', (req, res) => {
    res.json({ ok: true, data: mdm.stats(), ts: Date.now() });
  });

  // ── /api/health ───────────────────────────────────────────────────
  router.get('/health', (req, res) => {
    res.json({ ok: true, status: 'running', uptime: process.uptime(), ts: Date.now() });
  });

  return router;
}

module.exports = createRouter;
