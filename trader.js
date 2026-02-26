// InnerG Kalshi Auto-Trader - Live BTC 15-Minute
import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const KALSHI_API_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_KEY = process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;

// Trading config
const CONFIG = {
  tradeAmount: 10,        // Contracts per trade
  maxTradesPerDay: 50,
  maxLossPerDay: 100,
  minConfidence: 0.52,    // Only trade if >52% confidence
  dryRun: true,           // Set to false for live trading
  checkInterval: 30000,   // Check every 30 seconds
};

// State
let state = {
  balance: 0,
  trades: [],
  dailyPnL: 0,
  dailyTrades: 0,
  btcPrices: [],
  lastTrade: null,
};

// ============================================
// KALSHI API AUTHENTICATION
// ============================================

function signRequest(method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = timestamp + method + path + body;
  
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  
  const signature = sign.sign(PRIVATE_KEY, 'base64');
  
  return {
    'KALSHI-ACCESS-KEY': API_KEY,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
  };
}

async function kalshiRequest(method, path, body = null) {
  const url = KALSHI_API_URL + path;
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    ...signRequest(method, path, bodyStr),
  };
  
  const options = { method, headers };
  if (body) options.body = bodyStr;
  
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (!response.ok) {
    console.error('API Error:', data);
    return { error: data };
  }
  
  return data;
}

// ============================================
// MARKET DATA
// ============================================

async function getBalance() {
  try {
    const data = await kalshiRequest('GET', '/portfolio/balance');
    return data;
  } catch (e) {
    console.error('Balance error:', e.message);
    return null;
  }
}

async function getBtc15MinMarket() {
  try {
    // Get current active 15-min BTC market
    const response = await fetch(`${KALSHI_API_URL}/markets?series_ticker=KXBTC15M&status=open&limit=1`);
    const data = await response.json();
    
    if (data.markets && data.markets.length > 0) {
      // Get full market details
      const ticker = data.markets[0].ticker;
      const detailResponse = await fetch(`${KALSHI_API_URL}/markets/${ticker}`);
      const detail = await detailResponse.json();
      return detail.market;
    }
    return null;
  } catch (e) {
    console.error('Market fetch error:', e.message);
    return null;
  }
}

async function getOrderbook(ticker) {
  try {
    const response = await fetch(`${KALSHI_API_URL}/markets/${ticker}/orderbook`);
    const data = await response.json();
    return data.orderbook;
  } catch (e) {
    console.error('Orderbook error:', e.message);
    return null;
  }
}

// ============================================
// BTC PRICE
// ============================================

async function getBtcPrice() {
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await response.json();
    return parseFloat(data.price);
  } catch (e) {
    console.error('BTC price error:', e.message);
    return null;
  }
}

// ============================================
// TRADING STRATEGY
// ============================================

function analyzePriceMovement() {
  if (state.btcPrices.length < 5) {
    return { direction: null, confidence: 0, reason: 'Need more price data' };
  }
  
  const recent = state.btcPrices.slice(-20);
  const first = recent[0];
  const last = recent[recent.length - 1];
  
  // Momentum: compare recent prices
  let upMoves = 0;
  let downMoves = 0;
  
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price > recent[i-1].price) upMoves++;
    else if (recent[i].price < recent[i-1].price) downMoves++;
  }
  
  const totalMoves = upMoves + downMoves;
  const momentum = upMoves / totalMoves;
  
  // Price change percentage
  const priceChange = ((last.price - first.price) / first.price) * 100;
  
  // Direction based on momentum
  let direction = null;
  let confidence = 0;
  
  if (momentum > 0.55) {
    direction = 'yes';  // Price going up
    confidence = momentum;
  } else if (momentum < 0.45) {
    direction = 'no';   // Price going down
    confidence = 1 - momentum;
  } else {
    // Too close to call - look at recent trend
    const veryRecent = recent.slice(-5);
    const recentTrend = veryRecent[veryRecent.length-1].price - veryRecent[0].price;
    if (recentTrend > 0) {
      direction = 'yes';
      confidence = 0.51;
    } else {
      direction = 'no';
      confidence = 0.51;
    }
  }
  
  return {
    direction,
    confidence,
    upMoves,
    downMoves,
    priceChange: priceChange.toFixed(4),
    momentum: (momentum * 100).toFixed(1) + '%',
    currentPrice: last.price
  };
}

// ============================================
// ORDER EXECUTION
// ============================================

async function placeOrder(marketTicker, side, count, price) {
  if (CONFIG.dryRun) {
    console.log(`\n🎯 [DRY RUN] Would place order:`);
    console.log(`   Market: ${marketTicker}`);
    console.log(`   Side: ${side.toUpperCase()}`);
    console.log(`   Count: ${count} contracts`);
    console.log(`   Price: ${price}¢`);
    return { success: true, dryRun: true };
  }
  
  const body = {
    ticker: marketTicker,
    side: side,
    action: 'buy',
    count: count,
    expiration_ts: Math.floor(Date.now() / 1000) + 300,
    type: 'limit',
    yes_price: side === 'yes' ? price : 100 - price,
  };
  
  console.log('\n📤 Placing live order...');
  const result = await kalshiRequest('POST', '/portfolio/orders', body);
  return result;
}

// ============================================
// MAIN TRADING LOOP
// ============================================

async function runTradingLoop() {
  const now = new Date();
  console.log('\n' + '='.repeat(50));
  console.log(`🕐 ${now.toLocaleTimeString('en-US')} | InnerG Kalshi Auto-Trader`);
  console.log('='.repeat(50));
  
  // 1. Get current BTC price
  const btcPrice = await getBtcPrice();
  if (btcPrice) {
    state.btcPrices.push({
      price: btcPrice,
      time: now
    });
    // Keep last 100 prices
    if (state.btcPrices.length > 100) {
      state.btcPrices = state.btcPrices.slice(-100);
    }
    console.log(`\n📊 BTC: $${btcPrice.toLocaleString()}`);
  }
  
  // 2. Get KALSHI 15-min market
  const market = await getBtc15MinMarket();
  
  if (!market) {
    console.log('⚠️  No active BTC 15-min market found');
    return;
  }
  
  console.log(`\n🎯 Market: ${market.ticker}`);
  console.log(`   Title: ${market.title}`);
  console.log(`   Price to beat: $${market.floor_strike?.toLocaleString()}`);
  console.log(`   YES: ${market.yes_bid}¢ / ${market.yes_ask}¢`);
  console.log(`   NO: ${market.no_bid}¢ / ${market.no_ask}¢`);
  console.log(`   Volume: ${market.volume?.toLocaleString()}`);
  
  // Time until close
  const closeTime = new Date(market.close_time);
  const minsLeft = Math.round((closeTime - now) / 1000 / 60);
  console.log(`   Closes in: ${minsLeft} minutes`);
  
  // 3. Analyze price movement
  const analysis = analyzePriceMovement();
  console.log(`\n📈 Analysis:`);
  console.log(`   Momentum: ${analysis.momentum || 'N/A'}`);
  console.log(`   Direction: ${analysis.direction?.toUpperCase() || 'N/A'}`);
  console.log(`   Confidence: ${analysis.confidence ? (analysis.confidence * 100).toFixed(1) + '%' : 'N/A'}`);
  
  // 4. Trading decision
  if (analysis.confidence >= CONFIG.minConfidence && analysis.direction) {
    const price = analysis.direction === 'yes' ? market.yes_ask : market.no_ask;
    
    console.log(`\n🚨 TRADE SIGNAL: ${analysis.direction.toUpperCase()}`);
    
    // Check daily limits
    if (state.dailyTrades >= CONFIG.maxTradesPerDay) {
      console.log('   ⛔ Max daily trades reached');
      return;
    }
    if (state.dailyPnL <= -CONFIG.maxLossPerDay) {
      console.log('   ⛔ Max daily loss reached');
      return;
    }
    
    // Place trade
    const result = await placeOrder(market.ticker, analysis.direction, CONFIG.tradeAmount, price);
    
    if (result.success || result.order) {
      state.dailyTrades++;
      state.lastTrade = {
        direction: analysis.direction,
        price: price,
        market: market.ticker,
        time: now,
        btcPrice: btcPrice
      };
      
      console.log(`   ✅ Trade ${CONFIG.dryRun ? 'simulated' : 'placed'}!`);
    } else {
      console.log(`   ❌ Trade failed:`, result.error || result);
    }
  } else {
    console.log(`\n⏸️  No trade - confidence ${(analysis.confidence * 100).toFixed(1)}% < ${(CONFIG.minConfidence * 100)}%`);
  }
  
  // 5. Check balance
  if (!CONFIG.dryRun) {
    const balance = await getBalance();
    if (balance) {
      state.balance = balance.balance;
      console.log(`\n💰 Balance: $${state.balance?.toFixed(2)}`);
    }
  }
  
  console.log(`\n📊 Daily Stats: ${state.dailyTrades} trades | P&L: $${state.dailyPnL.toFixed(2)}`);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n' + '█'.repeat(50));
  console.log('  InnerG Kalshi Auto-Trader');
  console.log('  BTC 15-Minute Prediction Market');
  console.log('█'.repeat(50));
  
  console.log(`\n⚙️  Config:`);
  console.log(`   Mode: ${CONFIG.dryRun ? 'DRY RUN (paper)' : '🔴 LIVE TRADING'}`);
  console.log(`   Trade size: ${CONFIG.tradeAmount} contracts`);
  console.log(`   Min confidence: ${(CONFIG.minConfidence * 100)}%`);
  console.log(`   Max trades/day: ${CONFIG.maxTradesPerDay}`);
  console.log(`   Max loss/day: $${CONFIG.maxLossPerDay}`);
  
  // Run immediately
  await runTradingLoop();
  
  // Then run on interval
  setInterval(runTradingLoop, CONFIG.checkInterval);
}

main().catch(console.error);
