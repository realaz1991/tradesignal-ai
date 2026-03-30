// models/Asset.js
'use strict';

class Asset {
  constructor({ symbol, tdSymbol, type, icon, color, decimals }) {
    this.symbol   = symbol;
    this.tdSymbol = tdSymbol;
    this.type     = type;     // 'forex' | 'commodity'
    this.icon     = icon;
    this.color    = color;
    this.decimals = decimals;

    // Live state
    this.price    = null;
    this.open     = null;
    this.high     = null;
    this.low      = null;
    this.prevClose = null;
    this.change   = null;
    this.changePct = null;
    this.updatedAt = null;
  }

  updatePrice(price, prevClose = null) {
    this.price = parseFloat(price);
    if (prevClose !== null) this.prevClose = parseFloat(prevClose);
    if (this.prevClose) {
      this.change    = parseFloat((this.price - this.prevClose).toFixed(this.decimals));
      this.changePct = parseFloat(((this.change / this.prevClose) * 100).toFixed(3));
    }
    this.updatedAt = Date.now();
  }

  formatPrice(value = this.price) {
    return value != null ? Number(value).toFixed(this.decimals) : '--';
  }

  toJSON() {
    return {
      symbol:    this.symbol,
      type:      this.type,
      icon:      this.icon,
      color:     this.color,
      decimals:  this.decimals,
      price:     this.price,
      open:      this.open,
      high:      this.high,
      low:       this.low,
      prevClose: this.prevClose,
      change:    this.change,
      changePct: this.changePct,
      updatedAt: this.updatedAt,
    };
  }
}

// Singleton asset registry
class AssetRegistry {
  constructor() {
    this._assets = new Map();
    this._initDefaults();
  }

  _initDefaults() {
    const defs = [
      { symbol:'EUR/USD', tdSymbol:'EUR/USD',  type:'forex',     icon:'€$', color:'#4f8ef7', decimals:5 },
      { symbol:'GBP/USD', tdSymbol:'GBP/USD',  type:'forex',     icon:'£$', color:'#a78bfa', decimals:5 },
      { symbol:'USD/JPY', tdSymbol:'USD/JPY',  type:'forex',     icon:'$¥', color:'#f59e0b', decimals:3 },
      { symbol:'AUD/USD', tdSymbol:'AUD/USD',  type:'forex',     icon:'A$', color:'#10d88e', decimals:5 },
      { symbol:'USD/CHF', tdSymbol:'USD/CHF',  type:'forex',     icon:'$₣', color:'#f5475b', decimals:5 },
      { symbol:'XAU/USD', tdSymbol:'XAU/USD',  type:'commodity', icon:'Au', color:'#f59e0b', decimals:2 },
      { symbol:'WTI',     tdSymbol:'WTI/USD',  type:'commodity', icon:'🛢', color:'#6b7280', decimals:2 },
      { symbol:'BRENT',   tdSymbol:'BZ/USD',   type:'commodity', icon:'⛽', color:'#9ca3af', decimals:2 },
      { symbol:'XAG/USD', tdSymbol:'XAG/USD',  type:'commodity', icon:'Ag', color:'#d1d5db', decimals:3 },
    ];
    defs.forEach(d => this._assets.set(d.symbol, new Asset(d)));
  }

  get(symbol)   { return this._assets.get(symbol); }
  getAll()      { return Array.from(this._assets.values()); }
  getSymbols()  { return Array.from(this._assets.keys()); }
  getTdSymbols(){ return this.getAll().map(a => a.tdSymbol); }
}

module.exports = { Asset, AssetRegistry };
