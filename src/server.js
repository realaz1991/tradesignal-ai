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

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TD_KEY      = process.env.TWELVE_DATA_API_KEY;

if (!FINNHUB_KEY) { console.error('FINNHUB_API_KEY eksik!'); process.exit(1); }
if (!TD_KEY)      { console.warn('[WARN] TWELVE_DATA_API_KEY yok — mum verisi çalışmaz'); }

// Her iki key'i env'e yaz (FinnhubService içinde process.env'den okur)
process.env.TWELVE_DATA_API_KEY = TD_KEY || '';

const mdm = new MarketDataManager(FINNHUB_KEY);

app.use('/api', createApiRouter(mdm));
const wsServer = new TradeSignalWSServer(server, mdm);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 TradeSignal AI — PORT:${PORT}`);
  console.log(`   Finnhub WS  : aktif (canlı fiyat)`);
  console.log(`   Twelve Data : ${TD_KEY ? 'aktif (mum verisi)' : 'EKSİK!'}\n`);
  mdm.start().catch(e => console.error('[MDM]', e.message));
});

process.on('SIGTERM', () => { mdm.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { mdm.stop(); server.close(() => process.exit(0)); });
