// InnerG Kalshi Auto-Trader - Adaptive Learning System
import fetch from 'node-fetch';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const KALSHI_API_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_KEY = process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;

// Trading config
const CONFIG = {
  tradeAmount: 1,         // $1 per trade
  maxTradesPerDay: 50,
  maxLossPerDay: 25,
  minConfidence: 0.55,
  dryRun: false,          // 🔴 LIVE TRADING
  checkInterval: 15000,
  learningRate: 0.1,      // How fast to adjust strategy weights
  markets: ['KXBTC15M', 'KXETH15M'], // 15-min BTC + ETH (5m not available)
};

// Learning state - tracks strategy performance
let learning = {
  strategies: {
    momentum: { wins: 0, losses: 0, weight: 1.0, signals: [] },
    reversal: { wins: 0, losses: 0, weight: 1.0, signals: [] },
    orderbook: { wins: 0, losses: 0, weight: 1.0, signals: [] },
    timing: { wins: 0, losses: 0, weight: 1.0, signals: [] },
  },
  recentTrades: [],
  bestStrategy: null,
  totalTrades: 0,
  learningPhase: true,  // Start in learning mode
};

// State
let state = {
  balance: 0,
  btcPrices: [],
  ethPrices: [],
  dailyPnL: 0,
  dailyLosses: 0,
  dailyTrades: 0,
  activePositions: [],
  lastSignals: {},
};

// Load learning state from file
function loadLearningState() {
  try {
    const data = fs.readFileSync('./learning-state.json', 'utf8');
    learning = JSON.parse(data);
    console.log('📚 Loaded previous learning state');
    console.log(`   Total trades learned from: ${learning.totalTrades}`);
  } catch (e) {
    console.log('📚 Starting fresh learning state');
  }
}

// Save learning state
function saveLearningState() {
  fs.writeFileSync('./learning-state.json', JSON.stringify(learning, null, 2));
}

// ============================================
// KALSHI API
// ============================================

function signRequest(method, path, body = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = timestamp + method + path + body;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return {
    'KALSHI-ACCESS-KEY': API_KEY,
    'KALSHI-ACCESS-SIGNATURE': sign.sign(PRIVATE_KEY, 'base64'),
    'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
  };
}

async function kalshiRequest(method, path, body = null) {
  const url = KALSHI_API_URL + path;
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', ...signRequest(method, path, bodyStr) };
  const options = { method, headers };
  if (body) options.body = bodyStr;
  const response = await fetch(url, options);
  return response.json();
}

async function getBalance() {
  try {
    const data = await kalshiRequest('GET', '/portfolio/balance');
    return data;
  } catch (e) { return null; }
}

async function getMarkets(series) {
  try {
    const response = await fetch(`${KALSHI_API_URL}/markets?series_ticker=${series}&status=open&limit=3`);
    const data = await response.json();
    return data.markets || [];
  } catch (e) { return []; }
}

async function getMarketDetails(ticker) {
  try {
    const response = await fetch(`${KALSHI_API_URL}/markets/${ticker}`);
    const data = await response.json();
    return data.market;
  } catch (e) { return null; }
}

async function getOrderbook(ticker) {
  try {
    const response = await fetch(`${KALSHI_API_URL}/markets/${ticker}/orderbook`);
    const data = await response.json();
    return data.orderbook;
  } catch (e) { return null; }
}

// ============================================
// PRICE DATA
// ============================================

async function getBtcPrice() {
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await response.json();
    return parseFloat(data.price);
  } catch (e) { return null; }
}

async function getEthPrice() {
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await response.json();
    return parseFloat(data.price);
  } catch (e) { return null; }
}

// ============================================
// STRATEGY SIGNALS
// ============================================

function momentumSignal(prices) {
  // Trend following - if price moving up, bet YES; down = NO
  if (prices.length < 10) return { direction: null, confidence: 0 };
  
  const recent = prices.slice(-10);
  let upCount = 0, downCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].price > recent[i-1].price) upCount++;
    else if (recent[i].price < recent[i-1].price) downCount++;
  }
  
  const total = upCount + downCount;
  const momentum = upCount / total;
  
  // Strong momentum = high confidence
  let direction, confidence;
  if (momentum > 0.65) {
    direction = 'yes';
    confidence = momentum;
  } else if (momentum < 0.35) {
    direction = 'no';
    confidence = 1 - momentum;
  } else {
    direction = momentum > 0.5 ? 'yes' : 'no';
    confidence = 0.51;
  }
  
  return { direction, confidence, upCount, downCount, momentum };
}

function reversalSignal(prices) {
  // Mean reversion - bet against extreme moves
  if (prices.length < 15) return { direction: null, confidence: 0 };
  
  const recent = prices.slice(-15);
  const changes = [];
  
  for (let i = 1; i < recent.length; i++) {
    const pct = (recent[i].price - recent[i-1].price) / recent[i-1].price;
    changes.push(pct);
  }
  
  const totalChange = changes.reduce((a, b) => a + b, 0);
  const avgChange = totalChange / changes.length;
  
  // If strong move in one direction, bet reversal
  let direction, confidence;
  if (totalChange > 0.002) { // +0.2% move up
    direction = 'no';  // Bet it'll go down
    confidence = Math.min(0.7, 0.5 + totalChange * 50);
  } else if (totalChange < -0.002) { // -0.2% move down
    direction = 'yes'; // Bet it'll go up
    confidence = Math.min(0.7, 0.5 + Math.abs(totalChange) * 50);
  } else {
    direction = null;
    confidence = 0;
  }
  
  return { direction, confidence, totalChange: (totalChange * 100).toFixed(3) + '%' };
}

async function orderbookSignal(market) {
  // Follow smart money in orderbook
  const book = await getOrderbook(market.ticker);
  if (!book || !book.yes || !book.no) return { direction: null, confidence: 0 };
  
  // Calculate total volume on each side
  let yesVolume = book.yes.reduce((sum, [price, qty]) => sum + qty, 0);
  let noVolume = book.no.reduce((sum, [price, qty]) => sum + qty, 0);
  const total = yesVolume + noVolume;
  
  if (total === 0) return { direction: null, confidence: 0 };
  
  const yesRatio = yesVolume / total;
  
  // If heavy volume on one side, follow it
  let direction, confidence;
  if (yesRatio > 0.6) {
    direction = 'yes';
    confidence = yesRatio;
  } else if (yesRatio < 0.4) {
    direction = 'no';
    confidence = 1 - yesRatio;
  } else {
    direction = yesRatio > 0.5 ? 'yes' : 'no';
    confidence = 0.52;
  }
  
  return { direction, confidence, yesVolume, noVolume, yesRatio: (yesRatio * 100).toFixed(1) + '%' };
}

function timingSignal(market, now) {
  // Trade differently based on time in candle
  const closeTime = new Date(market.close_time);
  const openTime = new Date(market.open_time);
  const totalDuration = closeTime - openTime;
  const elapsed = now - openTime;
  const progress = elapsed / totalDuration;
  
  // First 20%: more aggressive (catch early moves)
  // Middle 60%: normal
  // Last 20%: more conservative (avoid late volatility)
  
  let modifier = 1.0;
  let note = 'mid-candle';
  
  if (progress < 0.2) {
    modifier = 1.15; // More confident early
    note = 'early-candle (aggressive)';
  } else if (progress > 0.8) {
    modifier = 0.85; // Less confident late
    note = 'late-candle (conservative)';
  }
  
  return { modifier, progress: (progress * 100).toFixed(0) + '%', note };
}

// ============================================
// COMBINE SIGNALS
// ============================================

function combineSignals(signals, market) {
  const { momentum, reversal, orderbook, timing } = signals;
  
  // Weight each signal by strategy performance
  const weights = learning.strategies;
  
  let yesScore = 0, noScore = 0;
  let totalWeight = 0;
  
  // Add momentum signal
  if (momentum.direction && momentum.confidence > 0.5) {
    const w = weights.momentum.weight * (learning.learningPhase ? 1 : weights.momentum.wins / Math.max(1, weights.momentum.wins + weights.momentum.losses));
    if (momentum.direction === 'yes') yesScore += momentum.confidence * w * timing.modifier;
    else noScore += momentum.confidence * w * timing.modifier;
    totalWeight += w;
  }
  
  // Add reversal signal
  if (reversal.direction && reversal.confidence > 0.5) {
    const w = weights.reversal.weight * (learning.learningPhase ? 1 : weights.reversal.wins / Math.max(1, weights.reversal.wins + weights.reversal.losses));
    if (reversal.direction === 'yes') yesScore += reversal.confidence * w * timing.modifier;
    else noScore += reversal.confidence * w * timing.modifier;
    totalWeight += w;
  }
  
  // Add orderbook signal
  if (orderbook.direction && orderbook.confidence > 0.5) {
    const w = weights.orderbook.weight * (learning.learningPhase ? 1 : weights.orderbook.wins / Math.max(1, weights.orderbook.wins + weights.orderbook.losses));
    if (orderbook.direction === 'yes') yesScore += orderbook.confidence * w;
    else noScore += orderbook.confidence * w;
    totalWeight += w;
  }
  
  if (totalWeight === 0) return { direction: null, confidence: 0 };
  
  // Normalize
  const total = yesScore + noScore;
  const direction = yesScore > noScore ? 'yes' : 'no';
  const confidence = Math.max(yesScore, noScore) / total;
  
  // Track which strategies contributed
  const contributing = [];
  if (momentum.direction === direction) contributing.push('momentum');
  if (reversal.direction === direction) contributing.push('reversal');
  if (orderbook.direction === direction) contributing.push('orderbook');
  
  return {
    direction,
    confidence,
    yesScore: yesScore.toFixed(2),
    noScore: noScore.toFixed(2),
    contributingStrategies: contributing,
    timingNote: timing.note
  };
}

// ============================================
// LEARNING UPDATE
// ============================================

function updateLearning(trade, won) {
  learning.totalTrades++;
  
  // Update each strategy that contributed to this trade
  trade.strategies.forEach(strategy => {
    if (won) {
      learning.strategies[strategy].wins++;
    } else {
      learning.strategies[strategy].losses++;
    }
    
    // Recalculate weight based on win rate
    const s = learning.strategies[strategy];
    const winRate = s.wins / Math.max(1, s.wins + s.losses);
    s.weight = 0.5 + winRate; // 0.5 base + up to 1.0 for perfect win rate
  });
  
  // Find best performing strategy
  let bestWinRate = 0;
  let best = null;
  for (const [name, s] of Object.entries(learning.strategies)) {
    const total = s.wins + s.losses;
    if (total >= 5) { // Need at least 5 trades to judge
      const winRate = s.wins / total;
      if (winRate > bestWinRate) {
        bestWinRate = winRate;
        best = name;
      }
    }
  }
  
  if (best) {
    learning.bestStrategy = best;
    // After 20+ trades, reduce learning phase
    if (learning.totalTrades >= 20) {
      learning.learningPhase = false;
    }
  }
  
  // Store recent trade
  learning.recentTrades.push({
    ...trade,
    won,
    time: new Date().toISOString()
  });
  
  // Keep last 100 trades
  if (learning.recentTrades.length > 100) {
    learning.recentTrades = learning.recentTrades.slice(-100);
  }
  
  saveLearningState();
}

// ============================================
// ORDER EXECUTION
// ============================================

async function placeOrder(marketTicker, side, count, price, strategies) {
  if (CONFIG.dryRun) {
    console.log(`\n🎯 [DRY RUN] Order:`);
    console.log(`   ${side.toUpperCase()} ${count}x ${marketTicker} @ ${price}¢`);
    console.log(`   Strategies: ${strategies.join(', ')}`);
    return { success: true, dryRun: true, strategies };
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
  
  const result = await kalshiRequest('POST', '/portfolio/orders', body);
  return { ...result, strategies };
}

// ============================================
// MAIN TRADING LOOP
// ============================================

async function runTradingLoop() {
  const now = new Date();
  console.log('\n' + '─'.repeat(50));
  console.log(`🕐 ${now.toLocaleTimeString()} | Learning: ${learning.learningPhase ? 'ACTIVE' : 'ADAPTIVE'}`);
  console.log('─'.repeat(50));
  
  // Get prices
  const btcPrice = await getBtcPrice();
  const ethPrice = await getEthPrice();
  
  if (btcPrice) {
    state.btcPrices.push({ price: btcPrice, time: now });
    if (state.btcPrices.length > 100) state.btcPrices = state.btcPrices.slice(-100);
    console.log(`📊 BTC: $${btcPrice.toLocaleString()}`);
  }
  if (ethPrice) {
    state.ethPrices.push({ price: ethPrice, time: now });
    if (state.ethPrices.length > 100) state.ethPrices = state.ethPrices.slice(-100);
    console.log(`📊 ETH: $${ethPrice.toLocaleString()}`);
  }
  
  // Check all configured markets
  let allMarkets = [];
  for (const series of CONFIG.markets) {
    const markets = await getMarkets(series);
    const timeframe = series.includes('15M') ? '15m' : series.includes('5M') ? '5m' : 'other';
    allMarkets.push(...markets.map(m => ({ ...m, timeframe, series })));
  }
  
  if (allMarkets.length === 0) {
    console.log('⚠️  No active markets');
    return;
  }
  
  // Analyze each market
  for (const m of allMarkets.slice(0, 2)) {
    const market = await getMarketDetails(m.ticker);
    if (!market) continue;
    
    console.log(`\n🎯 [${m.timeframe}] ${market.ticker}`);
    console.log(`   ${market.title}`);
    console.log(`   YES: ${market.yes_bid}¢/${market.yes_ask}¢ | NO: ${market.no_bid}¢/${market.no_ask}¢`);
    
    // Select price history based on asset
    const prices = m.series?.includes('ETH') ? state.ethPrices : state.btcPrices;
    const currentPrice = m.series?.includes('ETH') ? ethPrice : btcPrice;
    
    // Get all signals
    const momentum = momentumSignal(prices);
    const reversal = reversalSignal(prices);
    const orderbook = await orderbookSignal(market);
    const timing = timingSignal(market, now);
    
    console.log(`\n📈 Signals:`);
    console.log(`   Momentum: ${momentum.direction?.toUpperCase() || '-'} (${(momentum.confidence * 100 || 0).toFixed(0)}%)`);
    console.log(`   Reversal: ${reversal.direction?.toUpperCase() || '-'} (${(reversal.confidence * 100 || 0).toFixed(0)}%)`);
    console.log(`   Orderbook: ${orderbook.direction?.toUpperCase() || '-'} (${(orderbook.confidence * 100 || 0).toFixed(0)}%)`);
    console.log(`   Timing: ${timing.note}`);
    
    // Combine signals
    const combined = combineSignals({ momentum, reversal, orderbook, timing }, market);
    
    console.log(`\n🧠 Combined: ${combined.direction?.toUpperCase() || '-'} (${(combined.confidence * 100).toFixed(0)}%)`);
    console.log(`   Contributing: ${combined.contributingStrategies.join(', ') || 'none'}`);
    
    // Strategy performance summary
    console.log(`\n📊 Strategy Performance:`);
    for (const [name, s] of Object.entries(learning.strategies)) {
      const total = s.wins + s.losses;
      const winRate = total > 0 ? (s.wins / total * 100).toFixed(0) : '-';
      console.log(`   ${name}: ${s.wins}W/${s.losses}L (${winRate}%) weight=${s.weight.toFixed(2)}`);
    }
    
    if (learning.bestStrategy) {
      console.log(`   ⭐ Best: ${learning.bestStrategy}`);
    }
    
    // Trade decision
    if (combined.confidence >= CONFIG.minConfidence && combined.direction) {
      // Check limits
      if (state.dailyTrades >= CONFIG.maxTradesPerDay) {
        console.log('\n⛔ Max daily trades reached');
        continue;
      }
      if (state.dailyLosses >= CONFIG.maxLossPerDay) {
        console.log('\n⛔ Max daily losses reached');
        continue;
      }
      
      const price = combined.direction === 'yes' ? market.yes_ask : market.no_ask;
      
      console.log(`\n🚨 TRADE SIGNAL [${m.timeframe}]: ${combined.direction.toUpperCase()}`);
      
      const result = await placeOrder(
        market.ticker,
        combined.direction,
        CONFIG.tradeAmount,
        price,
        combined.contributingStrategies
      );
      
      if (result.success || result.order) {
        state.dailyTrades++;
        state.activePositions.push({
          market: market.ticker,
          direction: combined.direction,
          price,
          strategies: combined.contributingStrategies,
          time: now,
          assetPrice: currentPrice
        });
        console.log('   ✅ Trade placed!');
      }
    } else {
      console.log(`\n⏸️  No trade (${(combined.confidence * 100).toFixed(0)}% < ${CONFIG.minConfidence * 100}%)`);
    }
  }
  
  // Daily stats
  console.log(`\n💰 Today: ${state.dailyTrades} trades | Losses: ${state.dailyLosses}/${CONFIG.maxLossPerDay}`);
  console.log(`📚 Total learned: ${learning.totalTrades} trades`);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\n' + '█'.repeat(50));
  console.log('  InnerG Kalshi - Adaptive Learning Trader');
  console.log('  BTC 5-Minute + 15-Minute Markets');
  console.log('█'.repeat(50));
  
  loadLearningState();
  
  console.log(`\n⚙️  Config:`);
  console.log(`   Mode: ${CONFIG.dryRun ? 'DRY RUN' : '🔴 LIVE'}`);
  console.log(`   Trade size: $${CONFIG.tradeAmount}`);
  console.log(`   Max trades: ${CONFIG.maxTradesPerDay}/day`);
  console.log(`   Max losses: ${CONFIG.maxLossPerDay}/day`);
  console.log(`   Learning: ${learning.learningPhase ? 'Gathering data...' : 'Adaptive mode'}`);
  
  await runTradingLoop();
  setInterval(runTradingLoop, CONFIG.checkInterval);
}

main().catch(console.error);
