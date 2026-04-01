// routes/api.js
'use strict';

const express = require('express');

function createRouter(mdm) {
  const router = express.Router();

  // GET /api/assets
  router.get('/assets', (req, res) => {
    res.json({ ok: true, data: mdm.getFullSnapshot(), ts: Date.now() });
  });

  // GET /api/asset/:symbol
  router.get('/asset/:symbol', (req, res) => {
    const data = mdm.getAssetSnapshot(decodeURIComponent(req.params.symbol));
    if (!data) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // GET /api/chart/:symbol/:tf
  router.get('/chart/:symbol/:tf', (req, res) => {
    const data = mdm.getChartData(
      decodeURIComponent(req.params.symbol),
      req.params.tf,
      parseInt(req.query.limit) || 120
    );
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // GET /api/signals/:symbol
  router.get('/signals/:symbol', (req, res) => {
    const signals = mdm.getAllSignals(decodeURIComponent(req.params.symbol));
    res.json({ ok: true, data: signals, ts: Date.now() });
  });

  // GET /api/signals
  router.get('/signals', (req, res) => {
    const tf = req.query.tf || '1h';
    const result = {};
    mdm.registry.getAll().forEach(asset => {
      const d = mdm.getMarketData(asset.symbol, tf);
      result[asset.symbol] = d?.signal?.toJSON() || null;
    });
    res.json({ ok: true, tf, data: result, ts: Date.now() });
  });

  // POST /api/ai/analyze — AI analizi backend'de yapılır
  router.post('/ai/analyze', async (req, res) => {
    const { symbol, tf, price, changePct, signal, rsi } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return res.json({
        ok: false,
        text: 'Anthropic API key eksik. hPanel → Environment Variables → ANTHROPIC_API_KEY ekle.',
        score: 0
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
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Forex analist. ${symbol} için Türkçe kısa analiz:
Zaman: ${tf} | Fiyat değişim: ${changePct}%
Sinyal: ${signal?.label} (${signal?.strength}%) | RSI: ${rsi}
MACD: ${signal?.type !== 'wait' ? 'aktif' : 'nötr'}
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

  // POST /api/ai/check — Sinyal için AI onay (bildirim öncesi)
  router.post('/ai/check', async (req, res) => {
    const { symbol, tf, signal, rsi, changePct } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // API key yoksa strength bazlı kural ver
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

  // GET /api/stats
  router.get('/stats', (req, res) => {
    res.json({ ok: true, data: mdm.stats(), ts: Date.now() });
  });

  // GET /api/health
  router.get('/health', (req, res) => {
    res.json({ ok: true, status: 'running', uptime: process.uptime(), ts: Date.now() });
  });

  return router;
}

module.exports = createRouter;
