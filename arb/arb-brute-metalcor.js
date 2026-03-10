const { Api, JsonRpc } = require('eosjs');
const fetch = require('node-fetch');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { Token, Pool, CurrencyAmount, Trade, computeAllRoutes } = require('@alcorexchange/alcor-swap-sdk');
const { asset } = require('eos-common');
const fs = require('fs');
const path = require('path');

// Configuration
const privateKeys = [process.env.FREE_LOVE];
const signatureProvider = new JsSignatureProvider(privateKeys);
const rpc = new JsonRpc('https://proton.greymass.com', { fetch });
const api = new Api({ rpc, signatureProvider });

const SWAP_CONTRACT = 'swap.alcor';
const PROTON_SWAPS_CONTRACT = 'proton.swaps';
const curr_actor = '2apes';
const xtokensContract = 'xtokens';
const eosioTokenContract = 'eosio.token';
const xmdContract = 'xmd.token';
const loanContract = 'loan.token';
const snipcoinsContract = 'snipcoins';
const senseContract = 'sense';
const protonmintContract = 'protonmint';
const storexContract = 'storex';
const xmdTreasuryContract = 'xmd.treasury';

// Token list filtered to kept tokens
const tokens = [
  'XPR', 'XBTC', 'XUSDC', 'XETH', 'XMT', 'XADA', 'XLTC', 'XEOS', 'METAL', 'XMD',
  'XDOGE', 'XUSDT', 'LOAN', 'SNIPS', 'STRX', 'XPYUSD', 'XPAX'
];

// Stablecoins
const stablecoins = ['XUSDC', 'XPYUSD', 'XPAX', 'XUSDT'];
// Priority Alcor-only tokens
const priorityTokens = ['EASY', 'WON', 'INDEX'];

// Token precisions
const tokenPrecisions = {
  'XPR': 4, 'XBTC': 8, 'XUSDC': 6, 'XETH': 8, 'XMT': 8, 'XADA': 6, 'XLTC': 8, 'XEOS': 4, 'METAL': 8,
  'XMD': 6, 'XDOGE': 6, 'XUSDT': 6, 'LOAN': 4, 'SNIPS': 4, 'STRX': 4,
  'XPYUSD': 6, 'XPAX': 6
};

// Token contracts
const tokenContracts = {
  'XPR': eosioTokenContract,
  'XMD': xmdContract,
  'LOAN': loanContract,
  'SNIPS': snipcoinsContract,
  'STRX': storexContract,
  'XBTC': xtokensContract, 'XUSDC': xtokensContract, 'XETH': xtokensContract,
  'XMT': xtokensContract, 'XADA': xtokensContract, 'XLTC': xtokensContract,
  'XEOS': xtokensContract, 'METAL': xtokensContract, 'XDOGE': xtokensContract,
  'XUSDT': xtokensContract,
  'XPYUSD': xtokensContract, 'XPAX': xtokensContract
};

function parseToken(tokenData) {
  const quantity = asset(tokenData.quantity);
  return new Token(
    tokenData.contract,
    quantity.symbol.precision(),
    quantity.symbol.code().to_string(),
    `${quantity.symbol.code().to_string()}-${tokenData.contract}`.toLowerCase()
  );
}

// Cache
let cachedProtonPools = null;
let cachedAlcorPools = null;
let lastPoolFetch = 0;
const POOL_CACHE_DURATION = 30000;
const routeCache = new Map(); // key: "SYM_IN->SYM_OUT", value: { route: number[] }
const routeCacheFile = path.join(__dirname, 'route-cache.json');
let persistentRoutes = {};

function loadRouteCacheFromDisk() {
  try {
    if (fs.existsSync(routeCacheFile)) {
      const data = fs.readFileSync(routeCacheFile, 'utf8');
      const parsed = JSON.parse(data || '{}');
      persistentRoutes = parsed;
      Object.entries(parsed).forEach(([k, v]) => {
        routeCache.set(k, v);
      });
      console.log(`[route-cache] Loaded ${routeCache.size} routes from disk`);
    }
  } catch (err) {
    console.warn('[route-cache] Failed to load cache from disk:', err.message);
  }
}

function saveRouteCacheToDisk() {
  try {
    fs.writeFileSync(routeCacheFile, JSON.stringify(persistentRoutes, null, 2));
  } catch (err) {
    console.warn('[route-cache] Failed to save cache to disk:', err.message);
  }
}

async function fetchProtonPools() {
  const now = Date.now();
  if (cachedProtonPools && (now - lastPoolFetch) < POOL_CACHE_DURATION) {
    return cachedProtonPools;
  }

  try {
    let pools = [];
    let more = true;
    let lower_bound = '';

    while (more) {
      const response = await rpc.get_table_rows({
        code: PROTON_SWAPS_CONTRACT,
        scope: PROTON_SWAPS_CONTRACT,
        table: 'pools',
        limit: 1000,
        lower_bound,
        show_payer: false
      });

      pools = pools.concat(response.rows);
      more = response.more;
      lower_bound = response.next_key;
    }

    const processedPools = pools.map(pool => ({
      id: pool.id,
      lt_symbol: pool.lt_symbol.split(',')[1],
      tokenA: pool.pool1.quantity.split(' ')[1],
      tokenB: pool.pool2.quantity.split(' ')[1],
      reserveA: parseFloat(pool.pool1.quantity),
      reserveB: parseFloat(pool.pool2.quantity),
      contractA: pool.pool1.contract,
      contractB: pool.pool2.contract
    })).filter(pool => pool.reserveA > 0 && pool.reserveB > 0);

    cachedProtonPools = processedPools;
    lastPoolFetch = now;
    return processedPools;
  } catch (error) {
    console.error('Error fetching Proton pools:', error);
    return cachedProtonPools || [];
  }
}

async function getSwapRate(fromTokenSymbol, toTokenSymbol) {
  const now = Date.now();
  if (!cachedAlcorPools || (now - lastPoolFetch) >= POOL_CACHE_DURATION) {
    try {
      let pools = [];
      let more = true;
      let lower_bound = '';

      while (more) {
        const response = await rpc.get_table_rows({
          code: SWAP_CONTRACT,
          scope: SWAP_CONTRACT,
          table: 'pools',
          limit: 1000,
          lower_bound,
          show_payer: false
        });

        pools = pools.concat(response.rows);
        more = response.more;
        lower_bound = response.next_key;
      }

      cachedAlcorPools = pools;
      lastPoolFetch = now;
    } catch (error) {
      console.error('Error fetching Alcor pools:', error);
      return { rate: 0, poolId: null };
    }
  }

  try {
    const poolData = cachedAlcorPools.find(p => {
      const symbols = [p.tokenA, p.tokenB].map(t =>
        asset(t.quantity).symbol.code().to_string()
      );
      return symbols.includes(fromTokenSymbol) && symbols.includes(toTokenSymbol);
    });

    if (!poolData) {
      return { rate: 0, poolId: null };
    }

    const pool = new Pool({
      ...poolData,
      tokenA: parseToken(poolData.tokenA),
      tokenB: parseToken(poolData.tokenB),
      sqrtPriceX64: poolData.currSlot.sqrtPriceX64,
      tickCurrent: poolData.currSlot.tick
    });

    const fromToken = [pool.tokenA, pool.tokenB].find(t => t.symbol === fromTokenSymbol);
    const toToken = [pool.tokenA, pool.tokenB].find(t => t.symbol === toTokenSymbol);

    if (!fromToken || !toToken) {
      return { rate: 0, poolId: null };
    }

    const fromTokenIsA = fromToken.equals(pool.tokenA);
    const price = fromTokenIsA
      ? parseFloat(pool.tokenAPrice.toFixed(8))
      : parseFloat(pool.tokenBPrice.toFixed(8));

    if (isNaN(price) || price <= 0) {
      return { rate: 0, poolId: null };
    }

    return { rate: price, poolId: poolData.id };
  } catch (error) {
    console.error(`Error in getSwapRate (${fromTokenSymbol} -> ${toTokenSymbol}):`, error);
    return { rate: 0, poolId: null };
  }
}

function getProtonRate(pool, fromToken, toToken) {
  if (pool.reserveA <= 0 || pool.reserveB <= 0) {
    return 0;
  }

  let rate;
  if (pool.tokenA === fromToken && pool.tokenB === toToken) {
    rate = pool.reserveB / pool.reserveA;
  } else if (pool.tokenB === fromToken && pool.tokenA === toToken) {
    rate = pool.reserveA / pool.reserveB;
  } else {
    return 0;
  }

  if (isNaN(rate) || rate <= 0) {
    return 0;
  }

  return rate;
}

async function getBalances() {
  const balances = {};
  const tokensWithBalance = [];

  for (const token of tokens) {
    const contract = tokenContracts[token];
    try {
      const balance = await rpc.get_table_rows({
        code: contract,
        table: 'accounts',
        scope: curr_actor,
        limit: 1,
        lower_bound: token,
        upper_bound: token
      });

      const balanceValue = balance.rows[0] ? parseFloat(balance.rows[0].balance.split(' ')[0]) : 0;
      balances[token] = balanceValue;

      if (balanceValue > 0.01) {
        tokensWithBalance.push(token);
      }
    } catch (error) {
      balances[token] = 0;
    }
  }

  return { balances, tokensWithBalance };
}

function getAmountTier(token) {
  if (token === 'XBTC') return 0.000001;
  if (token === 'XLTC') return 0.0001;
  if (token === 'METAL') return 0.0666;
  if (token === 'XPR') return 10;
  if (token === 'XDOGE') return 1;
  if (stablecoins.includes(token)) return 0.01;
  return 1;
}

async function executeArbitrageUnified({ from, to, amount, protonPool, isProtonToAlcor }) {
  try {
    let currentAmount = amount;
    let success = false;
    let attempts = 0;
    const maxAttempts = 1; // single try; no halving/backoff
    let initialAmount = currentAmount;
    let finalExpectedAmount = 0;
    let expectedProfit = 0;

    while (!success && attempts < maxAttempts) {
      initialAmount = currentAmount;
      try {
        const actions = [];
        let expectedOut = 0;

        if (isProtonToAlcor) {
          if (from !== 'XMD' && stablecoins.includes(from)) {
            actions.push({
              account: tokenContracts[from],
              name: 'transfer',
              authorization: [{ actor: curr_actor, permission: 'active' }],
              data: {
                from: curr_actor,
                to: xmdTreasuryContract,
                quantity: `${currentAmount.toFixed(tokenPrecisions[from])} ${from}`,
                memo: 'mint'
              }
            });
            from = 'XMD';
          }

          const protonRate = getProtonRate(protonPool, from, to);
          if (protonRate <= 0) {
            throw new Error(`Invalid Proton rate for ${from} to ${to}`);
          }
          expectedOut = currentAmount * protonRate;
          // Proton memo min-out matches what we intend to send to Alcor in the next action
          const memoNumberProton = Math.round(expectedOut * Math.pow(10, tokenPrecisions[to]));
          actions.push({
            account: tokenContracts[from],
            name: 'transfer',
            authorization: [{ actor: curr_actor, permission: 'active' }],
            data: {
              from: curr_actor,
              to: PROTON_SWAPS_CONTRACT,
              quantity: `${currentAmount.toFixed(tokenPrecisions[from])} ${from}`,
              memo: `${protonPool.lt_symbol},${memoNumberProton}`
            }
          });

          const tokenIn = new Token(tokenContracts[to], tokenPrecisions[to], to);
          const tokenOut = new Token(tokenContracts[from], tokenPrecisions[from], from);
          const amountIn = CurrencyAmount.fromRawAmount(tokenIn, Math.floor(expectedOut * Math.pow(10, tokenPrecisions[to])));
          const { route } = await findBestSwapRoute(amountIn, tokenOut);
          const minReceivedAlcor = initialAmount.toFixed(tokenPrecisions[from]); // no-loss: require at least initial amount back
          finalExpectedAmount = initialAmount;
          expectedProfit = 0;
          const memo = `swapexactin#${route.join(',')}#${curr_actor}#${minReceivedAlcor} ${from}@${tokenContracts[from]}#0`;
          actions.push({
            account: tokenContracts[to],
            name: 'transfer',
            authorization: [{ actor: curr_actor, permission: 'active' }],
            data: {
              from: curr_actor,
              to: SWAP_CONTRACT,
              quantity: `${expectedOut.toFixed(tokenPrecisions[to])} ${to}`,
              memo: memo
            }
          });

          if (from === 'XMD' && stablecoins.includes(to)) {
            actions.push({
              account: tokenContracts[from],
              name: 'transfer',
              authorization: [{ actor: curr_actor, permission: 'active' }],
              data: {
                from: curr_actor,
                to: xmdTreasuryContract,
                quantity: `${minReceivedAlcor} ${from}`,
                memo: `redeem,${to}`
              }
            });
            finalExpectedAmount = parseFloat(minReceivedAlcor);
            expectedProfit = finalExpectedAmount - initialAmount;
          }
        } else {
          const tokenIn = new Token(tokenContracts[from], tokenPrecisions[from], from);
          const tokenOut = new Token(tokenContracts[to], tokenPrecisions[to], to);
          const amountIn = CurrencyAmount.fromRawAmount(tokenIn, Math.floor(currentAmount * Math.pow(10, tokenPrecisions[from])));
          const { route } = await findBestSwapRoute(amountIn, tokenOut);
          // no-loss: ensure enough is received from Alcor to get back initialAmount via Proton rate
          const requiredTo = initialAmount / protonRate;
          const minReceivedAlcor = requiredTo.toFixed(tokenPrecisions[to]);
          const memo = `swapexactin#${route.join(',')}#${curr_actor}#${minReceivedAlcor} ${to}@${tokenContracts[to]}#0`;
          actions.push({
            account: tokenContracts[from],
            name: 'transfer',
            authorization: [{ actor: curr_actor, permission: 'active' }],
            data: {
              from: curr_actor,
              to: SWAP_CONTRACT,
              quantity: `${currentAmount.toFixed(tokenPrecisions[from])} ${from}`,
              memo: memo
            }
          });

          let intermediateToken = to;
          if (to !== 'XMD' && stablecoins.includes(to)) {
            actions.push({
              account: tokenContracts[to],
              name: 'transfer',
              authorization: [{ actor: curr_actor, permission: 'active' }],
              data: {
                from: curr_actor,
                to: xmdTreasuryContract,
                quantity: `${minReceivedAlcor} ${to}`,
                memo: 'mint'
              }
            });
            intermediateToken = 'XMD';
          }

          const protonRate = getProtonRate(protonPool, intermediateToken, from);
          if (protonRate <= 0) {
            throw new Error(`Invalid Proton rate for ${intermediateToken} to ${from}`);
          }
          const expectedOut = parseFloat(minReceivedAlcor) * protonRate;
          finalExpectedAmount = initialAmount;
          expectedProfit = 0;
          // Proton memo min-out matches what we send to Proton (minReceivedAlcor converted through rate)
          const memoNumberProton = Math.round(expectedOut * Math.pow(10, tokenPrecisions[from]));
          actions.push({
            account: tokenContracts[intermediateToken],
            name: 'transfer',
            authorization: [{ actor: curr_actor, permission: 'active' }],
            data: {
              from: curr_actor,
              to: PROTON_SWAPS_CONTRACT,
              quantity: `${minReceivedAlcor} ${intermediateToken}`,
              memo: `${protonPool.lt_symbol},${memoNumberProton}`
            }
          });

          if (intermediateToken === 'XMD' && stablecoins.includes(from)) {
            actions.push({
              account: tokenContracts[intermediateToken],
              name: 'transfer',
              authorization: [{ actor: curr_actor, permission: 'active' }],
              data: {
                from: curr_actor,
                to: xmdTreasuryContract,
                quantity: `${expectedOut.toFixed(tokenPrecisions[intermediateToken])} ${intermediateToken}`,
                memo: `redeem,${from}`
              }
            });
            finalExpectedAmount = initialAmount;
            expectedProfit = 0;
          }
        }

        console.log('\n=== TRANSACTION DETAILS ===');
        console.log('Direction:', isProtonToAlcor ? 'Proton->Alcor' : 'Alcor->Proton');
        console.log('Initial Amount:', initialAmount);
        console.log('Expected Final Amount:', finalExpectedAmount);
        console.log('Expected Profit:', expectedProfit);
        console.log('Actions:', JSON.stringify(actions, null, 2));

        const result = await api.transact({ actions }, {
          blocksBehind: 3,
          expireSeconds: 30,
        });

        if (result.processed.receipt.status === 'executed') {
          success = true;
          console.log('Transaction successful:', result.transaction_id);
        }
      } catch (error) {
        console.error('Transaction failed:', error.message);
      }
      attempts++;
    }

    return { success, expectedProfit };
  } catch (error) {
    console.error(`Arbitrage ${from}->${to} failed:`, error);
    return { success: false, expectedProfit: 0 };
  }
}

async function findBestSwapRoute(amountIn, tokenOut) {
  console.log(`[findBestSwapRoute] Routing ${amountIn.toExact()} -> ${tokenOut.symbol}`);

  const cacheKey = `${amountIn.currency.symbol}->${tokenOut.symbol}`;
  const reverseKey = `${tokenOut.symbol}->${amountIn.currency.symbol}`;
  if (routeCache.has(cacheKey)) {
    return routeCache.get(cacheKey);
  }
  // If reverse exists, reuse the same route IDs (direction is inferred by swapexactin)
  if (routeCache.has(reverseKey)) {
    const cached = routeCache.get(reverseKey);
    routeCache.set(cacheKey, cached);
    return cached;
  }

  const allPools = await fetchAllPoolsBasic();
  const tokensOfInterest = ['XMD', 'XUSDC', 'XPYUSD', 'XPAX', tokenOut.symbol, amountIn.currency.symbol, ...priorityTokens];
  const relevantPools = allPools.filter(p =>
    tokensOfInterest.includes(p.tokenA.symbol) && tokensOfInterest.includes(p.tokenB.symbol)
  );

  const poolsWithTicks = await Promise.all(
    relevantPools.map(async (p) => {
      const ticks = await rpc.get_table_rows({
        code: SWAP_CONTRACT,
        scope: p.id.toString(),
        table: 'ticks',
        limit: 1000
      });

      if (ticks.rows.length === 0) {
        return null;
      }

      return new Pool({
        ...p,
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        sqrtPriceX64: p.sqrtPriceX64,
        tickCurrent: p.tickCurrent,
        ticks: ticks.rows.sort((a, b) => a.id - b.id)
      });
    })
  ).then(pools => pools.filter(p => p !== null));

  const validRoutes = computeAllRoutes(amountIn.currency, tokenOut, poolsWithTicks, 2);
  if (validRoutes.length === 0) {
    throw new Error('No valid routes found');
  }

  const routeHasPriority = (route) => route.pools.some(
    (p) => priorityTokens.includes(p.tokenA.symbol) || priorityTokens.includes(p.tokenB.symbol)
  );
  const preferredRoutes = validRoutes.filter(routeHasPriority);
  const candidateRoutes = preferredRoutes.length ? preferredRoutes : validRoutes;

  const [bestTrade] = Trade.bestTradeExactIn(candidateRoutes, amountIn, 1);
  if (!bestTrade) {
    throw new Error('No profitable trade found');
  }

  const result = {
    route: bestTrade.route.pools.map(p => p.id)
  };
  if (routeHasPriority(bestTrade.route)) {
    persistentRoutes[cacheKey] = { route: result.route };
    persistentRoutes[reverseKey] = { route: result.route };
    routeCache.set(cacheKey, result);
    routeCache.set(reverseKey, result);
    saveRouteCacheToDisk();
  } else {
    routeCache.set(cacheKey, result);
    routeCache.set(reverseKey, result);
  }
  return result;
}

async function fetchAllPoolsBasic() {
  let pools = [];
  let more = true;
  let lower_bound = '';

  while (more) {
    const response = await rpc.get_table_rows({
      code: SWAP_CONTRACT,
      scope: SWAP_CONTRACT,
      table: 'pools',
      limit: 1000,
      lower_bound,
      show_payer: false
    });

    pools = pools.concat(response.rows.map(p => new Pool({
      ...p,
      tokenA: parseToken(p.tokenA),
      tokenB: parseToken(p.tokenB),
      sqrtPriceX64: p.currSlot.sqrtPriceX64,
      tickCurrent: p.currSlot.tick,
      ticks: []
    })));

    more = response.more;
    lower_bound = response.next_key;
  }

  return pools;
}

async function processPool(pool, balances) {
  const directions = [];
  const startA = getAmountTier(pool.tokenA);
  const startB = getAmountTier(pool.tokenB);

  if (balances[pool.tokenA] >= startA) {
    directions.push({ from: pool.tokenA, to: pool.tokenB });
  }
  if (balances[pool.tokenB] >= startB) {
    directions.push({ from: pool.tokenB, to: pool.tokenA });
  }

  for (const dir of directions) {
    let amount = getAmountTier(dir.from);
    let orientation = 'protonFirst';

    // Try Proton->Alcor first, then Alcor->Proton if it fails
    for (const isProtonToAlcor of [true, false]) {
      amount = getAmountTier(dir.from);
      while (amount <= balances[dir.from]) {
        console.log(`[processPool] Trying ${dir.from} -> ${dir.to} via ${isProtonToAlcor ? 'Proton->Alcor' : 'Alcor->Proton'} amount ${amount}`);
        const result = await executeArbitrageUnified({
          from: dir.from,
          to: dir.to,
          amount,
          protonPool: pool,
          isProtonToAlcor
        });

        if (result.success && result.expectedProfit > 0) {
          amount *= 2;
          continue;
        }

        // stop doubling on failure
        break;
      }
      // if succeeded at least once we already exhausted doubling; move to next pool
    }
  }
}

async function bruteForceArb() {
  while (true) {
    try {
      const { balances } = await getBalances();
      const protonPools = await fetchProtonPools();

      // sort pools by our balance weight (highest balance tokens first), fallback to liquidity
      const sortedPools = protonPools
        .filter(p => (balances[p.tokenA] > 0 || balances[p.tokenB] > 0))
        .slice()
        .sort((a, b) => {
          const balA = Math.max(balances[a.tokenA] || 0, balances[a.tokenB] || 0);
          const balB = Math.max(balances[b.tokenA] || 0, balances[b.tokenB] || 0);
          if (balA !== balB) return balB - balA;
          return (b.reserveA + b.reserveB) - (a.reserveA + a.reserveB);
        });

      for (const pool of sortedPools) {
        await processPool(pool, balances);
      }
    } catch (error) {
      console.error('Brute force loop error:', error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 555));
  }
}

(async () => {
  try {
    loadRouteCacheFromDisk();
    await bruteForceArb();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
})();

