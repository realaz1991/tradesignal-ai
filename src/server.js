// server.js
'use strict';

require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const MarketDataManager  = require('./services/MarketDataManager');
const TradeSignalWSServer = require('./services/WebSocketServer');
const createApiRouter     = require('./routes/api');

// ─── App ──────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Market Data Manager ──────────────────────────────────────────
const mdm = new MarketDataManager(process.env.TWELVE_DATA_API_KEY);

// ─── REST API ─────────────────────────────────────────────────────
app.use('/api', createApiRouter(mdm));

// ─── WebSocket ────────────────────────────────────────────────────
const wsServer = new TradeSignalWSServer(server, mdm);

// ─── Fallback → index.html ────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 TradeSignal AI Backend`);
  console.log(`   HTTP  → http://localhost:${PORT}`);
  console.log(`   WS    → ws://localhost:${PORT}`);
  console.log(`   API   → http://localhost:${PORT}/api/health\n`);

  // Start data loading in background (non-blocking)
  mdm.start().catch(e => console.error('[MDM] Start error:', e));
});

// Graceful shutdown
process.on('SIGTERM', () => { mdm.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { mdm.stop(); server.close(() => process.exit(0)); });
