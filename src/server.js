'use strict';

require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const MarketDataManager   = require('./services/MarketDataManager');
const TradeSignalWSServer = require('./services/WebSocketServer');
const createApiRouter     = require('./routes/api');

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TD_KEY      = process.env.TWELVE_DATA_API_KEY;

if (!FINNHUB_KEY) { console.error('FINNHUB_API_KEY eksik!'); process.exit(1); }
if (!TD_KEY)      { console.warn('[WARN] TWELVE_DATA_API_KEY yok — mum verisi çalışmaz'); }

process.env.TWELVE_DATA_API_KEY = TD_KEY || '';

const mdm = new MarketDataManager(FINNHUB_KEY);

// ── 1. API routes — EN ÖNCE (static'ten önce) ─────────────────────
app.use('/api', createApiRouter(mdm));

// ── 2. AI-specific endpoints ───────────────────────────────────────

// /api/market-snapshot — ChatGPT, Perplexity, Gemini, Claude için
app.get('/api/market-snapshot', (req, res) => {
  const assets = mdm.getFullSnapshot();
  const now    = new Date();
  const hour   = now.getUTCHours();
  const session = hour >= 13 ? 'New York Session' : hour >= 8 ? 'London Session' : 'Asian Session';
  const prices  = {};
  const signals = [];
  assets.forEach(a => {
    if (!a?.price) return;
    prices[a.symbol] = {
      price:      a.price,
      change_pct: a.changePct,
      direction:  (a.changePct||0) >= 0 ? 'up' : 'down',
    };
    Object.entries(a.timeframes||{}).forEach(([tf, d]) => {
      if (!d?.signal || d.signal.type === 'wait') return;
      signals.push({
        symbol: a.symbol, price: a.price, timeframe: tf,
        signal: d.signal.label, strength: d.signal.strength,
        rsi: d.indicators?.rsi,
      });
    });
  });
  res.json({
    title:          'TradeSignal AI — Live Forex & Commodity Prices',
    source:         'scanme.az/forex',
    generated:      now.toISOString(),
    market_session: session,
    summary:        assets.filter(a=>a?.price)
                      .map(a=>`${a.symbol}: ${a.price} (${a.changePct>=0?'+':''}${(a.changePct||0).toFixed(2)}%)`)
                      .join(', '),
    prices,
    top_signals:    signals.sort((a,b)=>(b.strength||0)-(a.strength||0)).slice(0,10),
    note: 'Prices from Finnhub. Signals: MACD(12,26,9) + RSI(14)',
  });
});

// /llms.txt — AI sistemleri için
app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# TradeSignal AI — Forex & Commodity Signal Platform
# Real-time forex and commodity prices with MACD+RSI signals
# Updated every 60 seconds

## Live Data Endpoints
GET /api/prices          — All current prices (JSON)
GET /api/signals         — MACD+RSI signals all timeframes (JSON)
GET /api/market-snapshot — Full market overview (JSON, AI-optimized)
GET /api/health          — System status (JSON)

## Instruments
Forex: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF
Commodities: XAU/USD (Gold), WTI Oil, Brent Oil, XAG/USD (Silver)

## Signal Types
sbuy  = Strong Buy  (MACD bullish + RSI 50-70)
buy   = Buy         (MACD positive + RSI > 50)
ssell = Strong Sell (MACD bearish + RSI 30-50)
sell  = Sell        (MACD negative + RSI < 50)
wait  = No signal

## Source
Website: https://scanme.az/forex
API: https://violet-hippopotamus-438533.hostingersite.com/api/
`);
});

// ── 3. Static files ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── 4. SPA fallback — EN SONDA ─────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── WebSocket ──────────────────────────────────────────────────────
const wsServer = new TradeSignalWSServer(server, mdm);

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 TradeSignal AI — PORT:${PORT}`);
  console.log(`   Finnhub WS  : aktif`);
  console.log(`   Twelve Data : ${TD_KEY ? 'aktif' : 'EKSİK!'}`);
  console.log(`   API         : /api/prices | /api/signals | /api/market-snapshot\n`);
  mdm.start().catch(e => console.error('[MDM]', e.message));
});

process.on('SIGTERM', () => { mdm.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { mdm.stop(); server.close(() => process.exit(0)); });
