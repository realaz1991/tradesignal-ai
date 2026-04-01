// server.js
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
app.use(express.static(path.join(__dirname, '../public')));

// ─── Market Data Manager ──────────────────────────────────────────
const API_KEY = process.env.FINNHUB_API_KEY || process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) { console.error('TWELVE_DATA_API_KEY eksik!'); process.exit(1); }

const mdm = new MarketDataManager(API_KEY);

// ─── REST API ─────────────────────────────────────────────────────
app.use('/api', createApiRouter(mdm));

// ─── WebSocket ────────────────────────────────────────────────────
const wsServer = new TradeSignalWSServer(server, mdm);

// ─── SPA fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 TradeSignal AI`);
  console.log(`   PORT: ${PORT}`);
  console.log(`   ENV:  ${process.env.NODE_ENV || 'production'}\n`);
  mdm.start().catch(e => console.error('[MDM]', e.message));
});

process.on('SIGTERM', () => { mdm.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { mdm.stop(); server.close(() => process.exit(0)); });
