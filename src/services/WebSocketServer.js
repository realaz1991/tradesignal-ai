// services/WebSocketServer.js
'use strict';

const { WebSocketServer, WebSocket } = require('ws');

class WSClient {
  constructor(ws, req) {
    this.ws          = ws;
    this.id          = Math.random().toString(36).slice(2, 10);
    this.ip          = req.socket.remoteAddress;
    this.connectedAt = Date.now();
    this.subscriptions = new Set(); // subscribed symbols
    this.alive       = true;
  }

  send(type, payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type, ...payload, ts: Date.now() }));
      return true;
    } catch { return false; }
  }

  isAlive() { return this.alive && this.ws.readyState === WebSocket.OPEN; }
}

class TradeSignalWSServer {
  constructor(httpServer, marketDataManager) {
    this.mdm     = marketDataManager;
    this.clients = new Map(); // id → WSClient
    this.wss     = new WebSocketServer({ server: httpServer });

    this._setup();
    this._setupHeartbeat();
    this._listenToMDM();

    console.log('[WS] WebSocket server attached to HTTP server');
  }

  _setup() {
    this.wss.on('connection', (ws, req) => {
      const client = new WSClient(ws, req);
      this.clients.set(client.id, client);
      console.log(`[WS] Client connected: ${client.id} (${client.ip}) total: ${this.clients.size}`);

      // Send full snapshot immediately on connect
      this._sendSnapshot(client);

      ws.on('message', (raw) => this._handleMessage(client, raw));

      ws.on('close', () => {
        this.clients.delete(client.id);
        console.log(`[WS] Client disconnected: ${client.id} total: ${this.clients.size}`);
      });

      ws.on('error', (err) => console.warn(`[WS] Client error ${client.id}:`, err.message));

      ws.on('pong', () => { client.alive = true; });
    });
  }

  _sendSnapshot(client) {
    const snapshot = this.mdm.getFullSnapshot();
    client.send('snapshot', { data: snapshot });

    // Also send chart data for EUR/USD 1h as default
    const chart = this.mdm.getChartData('EUR/USD', '1h');
    if (chart) client.send('chart', { data: chart });
  }

  _handleMessage(client, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'subscribe':
        (msg.symbols || []).forEach(s => client.subscriptions.add(s));
        client.send('subscribed', { symbols: [...client.subscriptions] });
        break;

      case 'unsubscribe':
        (msg.symbols || []).forEach(s => client.subscriptions.delete(s));
        break;

      case 'get_chart':
        // Client requests chart data for specific symbol/tf
        if (msg.symbol && msg.tf) {
          const chart = this.mdm.getChartData(msg.symbol, msg.tf);
          if (chart) client.send('chart', { data: chart });
        }
        break;

      case 'get_snapshot':
        this._sendSnapshot(client);
        break;

      case 'ping':
        client.send('pong', {});
        break;
    }
  }

  _listenToMDM() {
    // Broadcast price updates
    this.mdm.on('price', (data) => {
      this._broadcast('price', { data }, (client) =>
        client.subscriptions.size === 0 || client.subscriptions.has(data.symbol)
      );
    });

    // Broadcast candle/indicator/signal updates
    this.mdm.on('update', (data) => {
      this._broadcast('update', { data }, (client) =>
        client.subscriptions.size === 0 || client.subscriptions.has(data.symbol)
      );

      // If strong signal, broadcast as signal alert
      if (data.signal && (data.signal.type === 'sbuy' || data.signal.type === 'ssell')) {
        this._broadcast('signal', { data }, () => true);
      }
    });

    // Broadcast errors
    this.mdm.on('error', (data) => {
      this._broadcast('api_error', { data }, () => true);
    });

    // Ready event
    this.mdm.on('ready', (data) => {
      this._broadcast('ready', { data }, () => true);
    });
  }

  _broadcast(type, payload, filter = () => true) {
    let sent = 0;
    this.clients.forEach(client => {
      if (client.isAlive() && filter(client)) {
        client.send(type, payload);
        sent++;
      }
    });
    return sent;
  }

  _setupHeartbeat() {
    // Ping clients every 30s, drop dead connections
    setInterval(() => {
      this.clients.forEach((client, id) => {
        if (!client.isAlive()) {
          this.clients.delete(id);
          client.ws.terminate();
          return;
        }
        client.alive = false;
        try { client.ws.ping(); } catch {}
      });
    }, 30000);
  }

  stats() {
    return {
      clients: this.clients.size,
      clientList: Array.from(this.clients.values()).map(c => ({
        id: c.id, ip: c.ip, connectedAt: c.connectedAt,
        subscriptions: [...c.subscriptions],
      })),
    };
  }
}

module.exports = TradeSignalWSServer;
