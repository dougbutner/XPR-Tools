const { parentPort } = require('worker_threads');
const { Api, JsonRpc, RpcError } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');      // development only
const fetch = require('node-fetch');                                    // node only; not needed in browsers
const { TextEncoder, TextDecoder } = require('util');                   // node only; native TextEncoder/Decoder
const fs = require('fs');
const path = require('path');

const defaultPrivateKey = process.env.FLEXDROP; 
const signatureProvider = new JsSignatureProvider([defaultPrivateKey]);
const rpc = new JsonRpc('https://proton.greymass.com', { fetch });
const api = new Api({ rpc, signatureProvider, textDecoder: new TextDecoder(), textEncoder: new TextEncoder() });

// --- Action Scheduling --- \\
const Bagman = require('../../bagman.js');
const Chipper = require('../../chipper.js');

// --- Security --- \\
require('dotenv').config();

// --- Get API --- \\
const https = require('https');
const { log } = require('console');
const axios = require('axios').default;

const TIMESTAMP_FILE = path.join(__dirname, 'meme_drop_timestamps.txt');

// Function to read the timestamp file
function readTimestamps() {
    try {
        if (!fs.existsSync(TIMESTAMP_FILE)) {
            return {};
        }
        const data = fs.readFileSync(TIMESTAMP_FILE, 'utf8');
        const timestamps = {};
        data.split('\n').forEach(line => {
            if (line.trim()) {
                const [account, timestamp] = line.split(',');
                timestamps[account] = parseInt(timestamp);
            }
        });
        return timestamps;
    } catch (error) {
        console.error('Error reading timestamp file:', error);
        return {};
    }
}

// Function to update the timestamp file
function updateTimestamp(account) {
    try {
        const timestamps = readTimestamps();
        timestamps[account] = Date.now();
        
        const lines = Object.entries(timestamps).map(([acc, ts]) => `${acc},${ts}`);
        fs.writeFileSync(TIMESTAMP_FILE, lines.join('\n'));
    } catch (error) {
        console.error('Error updating timestamp file:', error);
    }
}

// Function to check if account is eligible
function isEligibleForDrop(account) {
    const timestamps = readTimestamps();
    const lastDropTime = timestamps[account] || 0;
    const twentyHoursInMs = 20 * 60 * 60 * 1000;
    return Date.now() - lastDropTime >= twentyHoursInMs;
}

const tokens = [
    { account: 'tokencreate', symbol: 'AIPC', marketId: '1107' }, // XPR/AIPC market
    { account: 'beggars', symbol: 'BEGGARS', marketId: '554' }, // XPR/ARK market
    { account: 'tokencreate', symbol: 'BANK', marketId: '541' }, // XPR/BANK market
    { account: 'tokencreate', symbol: 'BLPAD', marketId: '539' }, // XPR/BLPAD market
    { account: 'xxxtokens', symbol: 'CAT', marketId: '578' }, // XPR/CAT market
    { account: 'clanx', symbol: 'CLAN', marketId: '454' }, // XPR/CLAN market
    { account: 'electronteam', symbol: 'DANK', marketId: '424' }, // XPR/DANK market
    { account: 'tokencreate', symbol: 'DOG', marketId: '573' }, // XPR/DOG market
    { account: 'tokencreate', symbol: 'NUTMEG', marketId: '492' }, // XPR/NUTMEG market
    { account: 'purrspace', symbol: 'PURR', marketId: '442' }, // XPR/PURR market
    { account: 'xprpussydao', symbol: 'PUSSY', marketId: '385' }, // XPR/PUSSY market
    { account: 'snipcoins', symbol: 'SNIPS', marketId: '94' }, // XPR/SNIPS market
    { account: 'storex', symbol: 'STRX', marketId: '68' }, // XPR/STRX market
    { account: 'xtokens', symbol: 'XADA', marketId: '5' }, // XPR/XADA market
    { account: 'xtokens', symbol: 'XBNB', marketId: '8' }, // XPR/XBNB market
    { account: 'xtokens', symbol: 'XDOGE', marketId: '6' }, // XPR/XDOGE market
    { account: 'xtokens', symbol: 'XETH', marketId: '7' }, // XPR/XETH market
    { account: 'xtokens', symbol: 'XEUROC', marketId: '409' }, // XPR/XEUROC market
    { account: 'metaltoken', symbol: 'XMD', marketId: '842' }, // XPR/XMD market
    { account: 'xtokens', symbol: 'XMT', marketId: '9' }, // XPR/XMT market
    { account: 'xtokens', symbol: 'XPAXG', marketId: '538' }, // XPR/XPAXG market
    { account: 'xprn', symbol: 'XRPLT', marketId: '511' }, // XPR/XRPLT market
    { account: 'pepetoken', symbol: 'XUSDC', marketId: '807' }, // XPR/XUSDC market
    { account: 'xtokens', symbol: 'XXRP', marketId: '818' } // XPR/XXRP market
];

// Select a random token to determine eligible holders
const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
const tokenAccount = randomToken.account;
const tokenSymbol = randomToken.symbol;
const alcorMarketId = randomToken.marketId;

// --- Airdrop Tiers --- \\
const airdropTiers = [
  { minXprValue: 1000000, multiplier: 5 }, // Tier 1
  { minXprValue: 100000, multiplier: 4 },  // Tier 2
  { minXprValue: 10000, multiplier: 3 },    // Tier 3
  { minXprValue: 1000, multiplier: 2 },     // Tier 4
  { minXprValue: 0, multiplier: 1 }      // Default Tier
];

// --- Free Variables --- \\
peeps = [];
rewards_markets = [];

// List of accounts to exclude
const excludedAccounts = ['alcor', 'swap.alcor', 'xxxtokens', 'protonnz', 'paul']; // Add the accounts you want to exclude here

// Fetch the live price of the random token in XPR
axios.get(`https://proton.alcor.exchange/api/markets/${alcorMarketId}`)
  .then(response => {
    console.log('Alcor API Response:', response.data);
    if (response.data && response.data.last_price) {
      const tokenPriceInXpr = parseFloat(response.data.last_price);
      console.log(`Token price in XPR for ${tokenSymbol}:`, tokenPriceInXpr);

      // Create a promise to fetch the top holders of the random token
      const promPeeps = new Promise((resolve, reject) => {
        let allHolders = [];
        let offset = 0;
        const limit = 100; // Number of holders per request
        const maxHolders = 1000; // Total number of holders we want

        async function fetchHolders() {
          try {
            console.log(`Fetching holders from offset ${offset}`);
            const response = await axios.get(
              `https://lightapi.eosamsterdam.net/api/topholders/proton/${tokenAccount}/${tokenSymbol}/${limit}?offset=${offset}`
            );

            if (response.data && response.data.length > 0) {
              allHolders = allHolders.concat(response.data);
              offset += limit;

              if (allHolders.length < maxHolders && response.data.length === limit) {
                // If we haven't reached our target and got a full page, fetch more
                setTimeout(fetchHolders, 100); // Small delay to avoid rate limiting
              } else {
                // We've either reached our target or got all available holders
                resolve(allHolders.slice(0, maxHolders)); // Ensure we don't exceed maxHolders
              }
            } else {
              // No more holders to fetch
              resolve(allHolders);
            }
          } catch (error) {
            console.error('Error fetching holders:', error);
            reject(`Error fetching token holders: ${error}`);
          }
        }

        fetchHolders();
      });

      let batch = [];

      // Process the holders once the promise resolves
      promPeeps.then(holders => {
        console.log('Number of holders received:', holders.length);
        console.log('First few holders:', holders.slice(0, 3));
        moji = [
          "💰",
          "💵",
          "💸",
          "🤑",
          "🔄",
          "🔁",
          "🔃",
          "🐶",
          "🐱",
          "🐵",
          "🐷",
          "💲",
          "💹",
          "💱",
          "💴",
          "💶",
          "💷",
          "🏦",
          "🪙",
          "💎",
          "💍",
          "👑",
          "🏆",
          "🥇",
          "🚀",
          "⚡",
          "✨",
          "🔥",
          "🌟",
          "🌈",
          "🎯",
          "🎮",
          "🎲",
          "🎰",
          "🎁",
          "🎊",
          "🎉"
        ]

        holders.forEach(holder => {
          const accountName = holder[0] || 'buy.m3m3';
          const tokensHeld = parseFloat(holder[1]) || 0;

          // Skip if the account is in the excluded list
          if (excludedAccounts.includes(accountName)) {
            console.log(`Skipping ${accountName} - account is excluded`);
            return;
          }

          // Check if account is eligible for a drop
          if (!isEligibleForDrop(accountName)) {
            console.log(`Skipping ${accountName} - not eligible for drop yet`);
            return;
          }

          const xprValue = tokensHeld * tokenPriceInXpr;

          // Determine the multiplier based on the airdrop tiers
          let multiplier = 0;
          for (const tier of airdropTiers) {
            if (xprValue >= tier.minXprValue) {
              multiplier = tier.multiplier;
              break;
            }
          }

          // Calculate the reward in MEME
          let freePay = xprValue * multiplier / 100000;
          freePay = freePay.toFixed(4); // MEME has 4 decimal places
          if (freePay > 64) freePay = 64.2069;
          if (freePay < 4) freePay = 4.2069;

          if (multiplier > 0 && !['swap.alcor', 'proton.wrap', 'kucoindotxpr', 'xmd.treasury', 'xtokens', 'xmd.token'].includes(accountName)) {
            batch.push({
              contract: 'm3m3',
              action: 'transfer',
              actor: 'buy.m3m3',
              permission: 'active',
              data: {
                from: 'buy.m3m3',
                to: accountName,
                quantity: `${freePay} MEME`,
//                memo: `${moji[Math.floor(Math.random() * moji.length)] } 🥳 The First Customizable Reflective token on XPR [sends u more 4 hodlin] 🥇 Claim 1M $MEME b4 April 20 in t.me/flextokens 🪂 Hold 1M MEME to stack more MEME or customize to get ${tokenSymbol} + more 🔍 m3m3 on Alcor 🔓🤑 4 ${accountName} `
                  memo: `${moji[Math.floor(Math.random() * moji.length)] } 🥳 The First [Customizable] Reflective token on XPR [sends u more 4 hodlin] 🥇 Claim 1M $MEME b4 April 20 in t.me/flextokens 🪂 🔍 m3m3 on Alcor 🔓🤑 4 ${tokenSymbol} whale ${accountName} `              }
            });
            
            // Update the timestamp after adding to batch
            updateTimestamp(accountName);
          }
        });

        // --- Prepare Txs with eligible people list --- \\ 
        console.log("batch", batch); 
        console.log("Batch before processing:", batch.length);

        //batch = [];
        
        let chipCount = 1;
        let nowts = Date.now();

        let bagman = new Bagman(api);
        bagman.bags = batch;
        bagman.resFun = resFun;
        bagman.resFail = resFail;
        bagman.oneFun = oneFun;
        bagman.oneFail = oneFail;
        let chipper = new Chipper(bagman, chipCount);
        
        var len = Math.ceil(chipper.bagman.bags.length / chipCount);
        
        setTimeout(function run() {
          if(len-- > 0){
            chipper.chip();  
            setTimeout(run, 1000);
          } else {
            clearTimeout();
          }
        }, 0);
        delete len, nowts, chipCount, peeps;
        return true;

      }).catch(error => {
        console.error(error);
      });
    } else {
      console.error('Failed to fetch token price');
    }
  })
  .catch(error => {
    console.error("Error fetching token price:", error);
  });

// === Batch Handlers === \\

// --- Update the DB on successful Batch Tx  --- \\
function resFun(results = null, actionsObj = null){ 
    console.log('resultsTx', results.transaction_id);
}

// --- Handle failed Batch Tx --- \\
function resFail(results = false, actionsObj = null){
  if (Array.isArray(results) && results.length === 0) {
    console.log("resFail results were []", results);
  } else {
    console.log("resFail results were NOT []", results);
  }
}

// === Single Handles (For when the batch fails) === \\

// --- Update the DB on successful Single Tx  --- \\
function oneFun(result){
    let winnerwinner = result.processed.action_traces[0];
    console.log("Silver Away! " + winnerwinner.act.data.to)
}

// --- Handle failed Single Tx --- \\
function oneFail(result = false){
    console.log("oneFail")
    if (!!result){
      console.log("result from OneFail");
      console.log(result);
    }
}

// === Bree Shenanigans === \\

function cancel() {
  clearTimeout(); 
  if (parentPort) parentPort.postMessage('cancelled');
  else process.exit(0);
} 