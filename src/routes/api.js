// routes/api.js
'use strict';

const express = require('express');

function createRouter(mdm) {
  const router = express.Router();

  // GET /api/assets — all assets with live prices
  router.get('/assets', (req, res) => {
    const assets = mdm.getFullSnapshot();
    res.json({ ok: true, data: assets, ts: Date.now() });
  });

  // GET /api/asset/:symbol — single asset snapshot
  router.get('/asset/:symbol', (req, res) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const data   = mdm.getAssetSnapshot(symbol);
    if (!data) return res.status(404).json({ ok: false, error: 'Asset not found' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // GET /api/chart/:symbol/:tf — candles + indicators for chart
  router.get('/chart/:symbol/:tf', (req, res) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const tf     = req.params.tf;
    const limit  = parseInt(req.query.limit) || 120;
    const data   = mdm.getChartData(symbol, tf, limit);
    if (!data) return res.status(404).json({ ok: false, error: 'No data' });
    res.json({ ok: true, data, ts: Date.now() });
  });

  // GET /api/signals/:symbol — all TF signals for a symbol
  router.get('/signals/:symbol', (req, res) => {
    const symbol  = decodeURIComponent(req.params.symbol);
    const signals = mdm.getAllSignals(symbol);
    res.json({ ok: true, symbol, data: signals, ts: Date.now() });
  });

  // GET /api/signals — all signals for all assets (1h)
  router.get('/signals', (req, res) => {
    const tf = req.query.tf || '1h';
    const result = {};
    mdm.registry.getAll().forEach(asset => {
      const d = mdm.getMarketData(asset.symbol, tf);
      result[asset.symbol] = d?.signal?.toJSON() || null;
    });
    res.json({ ok: true, tf, data: result, ts: Date.now() });
  });

  // GET /api/stats — system stats
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
