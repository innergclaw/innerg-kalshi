// Test KALSHI API Connection
import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.KALSHI_API_KEY;
const PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY;

console.log('========================================');
console.log('KALSHI API Connection Test');
console.log('========================================\n');

console.log('API Key:', API_KEY ? `${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}` : 'NOT SET');
console.log('Private Key:', PRIVATE_KEY ? 'SET (' + PRIVATE_KEY.length + ' chars)' : 'NOT SET');
console.log('');

// Test 1: Fetch public markets (no auth needed)
async function testPublicMarkets() {
  console.log('📡 Test 1: Fetching public markets...');
  try {
    const response = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=5');
    const data = await response.json();
    
    if (data.markets && data.markets.length > 0) {
      console.log('✅ SUCCESS - Found', data.markets.length, 'markets\n');
      data.markets.forEach(m => {
        console.log(`   ${m.ticker}: ${m.title.slice(0, 50)}...`);
      });
      return true;
    } else {
      console.log('❌ No markets found');
      return false;
    }
  } catch (error) {
    console.log('❌ ERROR:', error.message);
    return false;
  }
}

// Test 2: Search for BTC markets
async function testBtcMarkets() {
  console.log('\n📡 Test 2: Searching for BTC markets...');
  try {
    const response = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=100');
    const data = await response.json();
    
    const btcMarkets = data.markets.filter(m => 
      m.title.toLowerCase().includes('bitcoin') ||
      m.title.toLowerCase().includes('btc') ||
      m.ticker.toUpperCase().includes('BTC')
    );
    
    if (btcMarkets.length > 0) {
      console.log('✅ Found', btcMarkets.length, 'BTC-related markets\n');
      btcMarkets.slice(0, 5).forEach(m => {
        console.log(`   ${m.ticker}: ${m.title}`);
        console.log(`   YES: ${m.yes_price}¢ | NO: ${100 - m.yes_price}¢\n`);
      });
      return true;
    } else {
      console.log('⚠️  No BTC markets found. Showing first 5 markets:');
      data.markets.slice(0, 5).forEach(m => {
        console.log(`   ${m.ticker}: ${m.title}`);
      });
      return false;
    }
  } catch (error) {
    console.log('❌ ERROR:', error.message);
    return false;
  }
}

// Test 3: Get BTC price
async function testBtcPrice() {
  console.log('\n📡 Test 3: Fetching BTC price...');
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await response.json();
    
    if (data.price) {
      console.log('✅ BTC Price:', '$' + parseFloat(data.price).toLocaleString());
      return true;
    }
  } catch (error) {
    console.log('❌ ERROR:', error.message);
    return false;
  }
}

// Run tests
async function runTests() {
  await testPublicMarkets();
  await testBtcMarkets();
  await testBtcPrice();
  
  console.log('\n========================================');
  console.log('Tests Complete');
  console.log('========================================');
  console.log('\nTo start trading:');
  console.log('  npm install');
  console.log('  npm start');
}

runTests();
