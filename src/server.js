'use strict';

require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const MarketDataManager   = require('./services/MarketDataManager');
const TradeSignalWSServer = require('./services/WebSocketServer');
const createApiRouter     = require('./routes/api');
const JsonFileWriter      = require('./services/JsonFileWriter');

const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TD_KEY      = process.env.TWELVE_DATA_API_KEY;

if (!FINNHUB_KEY) { console.error('FINNHUB_API_KEY eksik!'); process.exit(1); }
if (!TD_KEY)      { console.warn('[WARN] TWELVE_DATA_API_KEY yok'); }
process.env.TWELVE_DATA_API_KEY = TD_KEY || '';

const mdm        = new MarketDataManager(FINNHUB_KEY);
const jsonWriter = new JsonFileWriter(mdm);

// ── 1. API routes — önce ──────────────────────────────────────────
app.use('/api', createApiRouter(mdm));

// ── 2. llms.txt — AI crawlers için ───────────────────────────────
app.get('/llms.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# TradeSignal AI — Forex & Commodity Signal Platform
# Real-time forex and commodity prices with MACD+RSI signals

## LIVE DATA (updated every 60 seconds)
GET /data.json — Full market data, prices, signals (JSON)

## Instruments
Forex: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF
Commodities: XAU/USD (Gold), WTI Oil, Brent Oil, XAG/USD (Silver)

## Website: https://scanme.az/forex
`);
});

// ── 3. Static files (data.json burada servis edilir) ──────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── 4. SPA fallback ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── WebSocket ─────────────────────────────────────────────────────
const wsServer = new TradeSignalWSServer(server, mdm);

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 TradeSignal AI — PORT:${PORT}`);
  console.log(`   Finnhub WS  : aktif`);
  console.log(`   Twelve Data : ${TD_KEY ? 'aktif' : 'EKSİK!'}`);
  console.log(`   data.json   : /data.json — her 60sn güncellenir\n`);

  await mdm.start().catch(e => console.error('[MDM]', e.message));

  // MDM hazır olduktan sonra JSON writer'ı başlat
  jsonWriter.start(60000); // her 60 saniye
});

process.on('SIGTERM', () => { mdm.stop(); jsonWriter.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { mdm.stop(); jsonWriter.stop(); server.close(() => process.exit(0)); });
