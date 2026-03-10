const { Api, JsonRpc } = require('eosjs');
const fetch = require('node-fetch');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { Token, Pool, CurrencyAmount, Trade, computeAllRoutes } = require('@alcorexchange/alcor-swap-sdk');
const { asset } = require('eos-common');

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

// Token list from proton.swaps pools
const tokens = [
  'XPR', 'XBTC', 'XUSDC', 'XETH', 'XMT', 'XADA', 'XLTC', 'XEOS', 'METAL', 'XMD',
  'XDOGE', 'XUSDT', 'LOAN', 'SNIPS', 'STRX', 'XPYUSD', 'XPAX'  // Added stablecoins
];

// Define stablecoins array
const stablecoins = ['XUSDC', 'XPYUSD', 'XPAX'];

// Token precisions
const tokenPrecisions = {
  'XPR': 4, 'XBTC': 8, 'XUSDC': 6, 'XETH': 8, 'XMT': 8, 'XADA': 6, 'XLTC': 8, 'XEOS': 4, 'METAL': 8,
  'XMD': 6, 'XDOGE': 6, 'XUSDT': 6, 'LOAN': 4, 'SNIPS': 4, 'STRX': 4,
  'XPYUSD': 6, 'XPAX': 6  // Added stablecoin precisions
};

// Minimum amounts for specific tokens
const minimumAmounts = {
  'XPR': 10,
  'METAL': 1,
  'XMD': 0.1
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
  'XPYUSD': xtokensContract, 'XPAX': xtokensContract  // Added stablecoin contracts
};

// Parse token data for Alcor pools
function parseToken(tokenData) {
  const quantity = asset(tokenData.quantity);
  return new Token(
    tokenData.contract,
    quantity.symbol.precision(),
    quantity.symbol.code().to_string(),
    `${quantity.symbol.code().to_string()}-${tokenData.contract}`.toLowerCase()
  );
}

// Add cache variables at the top level
let cachedProtonPools = null;
let cachedAlcorPools = null;
let lastPoolFetch = 0;
const POOL_CACHE_DURATION = 30000; // 30 seconds

// Fetch proton.swaps pools with caching
async function fetchProtonPools() {
  const now = Date.now();
  if (cachedProtonPools && (now - lastPoolFetch) < POOL_CACHE_DURATION) {
    return cachedProtonPools;
  }

  console.log('Fetching Proton pools...');
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

// Get swap rate for Alcor with caching
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

// Calculate rate for proton.swaps pool
function getProtonRate(pool, fromToken, toToken) {
  // console.log(`\n[getProtonRate] Calculating rate for pool ${pool.lt_symbol} (${fromToken} -> ${toToken})`);
  
  if (pool.reserveA <= 0 || pool.reserveB <= 0) {
    // console.log('[getProtonRate] Invalid reserves - returning 0');
    return 0;
  }

  let rate;
  if (pool.tokenA === fromToken && pool.tokenB === toToken) {
    rate = pool.reserveB / pool.reserveA;
  } else if (pool.tokenB === fromToken && pool.tokenA === toToken) {
    rate = pool.reserveA / pool.reserveB;
  } else {
    // console.log('[getProtonRate] Token pair not found in pool');
    return 0;
  }

  // console.log(`[getProtonRate] Raw rate: ${rate}`);

  if (isNaN(rate) || rate <= 0) {
    // console.log(`[getProtonRate] Invalid rate: ${rate}`);
    return 0;
  }

  return rate;
}

// Get balances for all tokens and return tokens with non-zero balance
async function getBalances() {
  // console.log('\n[getBalances] Fetching token balances...');
  const balances = {};
  const tokensWithBalance = [];
  
  for (const token of tokens) {
    const contract = tokenContracts[token];
    // console.log(`[getBalances] Checking balance for ${token} (contract: ${contract})`);
    
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
      
      // console.log(`[getBalances] ${token} balance: ${balanceValue}`);
      
      if (balanceValue > 0.01) {
        // console.log(`[getBalances] ${token} has sufficient balance (>0.01)`);
        tokensWithBalance.push(token);
      }
    } catch (error) {
      // console.error(`[getBalances] Error fetching balance for ${token}:`, error);
      balances[token] = 0;
    }
  }
  
  // console.log(`[getBalances] Found ${tokensWithBalance.length} tokens with sufficient balance`);
  return { balances, tokensWithBalance };
}

// Check and execute arbitrage
async function checkArbitrage() {
  console.log('\n[checkArbitrage] Starting arbitrage check...');
  const failedOpportunities = new Set();
  const maxIterations = 1;
  let iterationCount = 0;
  
  do {
    if (iterationCount >= maxIterations) {
      console.log(`[checkArbitrage] Reached maximum iteration limit of ${maxIterations}. Starting new cycle.`);
      iterationCount = 0;
      failedOpportunities.clear();
      await new Promise(resolve => setTimeout(resolve, 555));
    }

    console.log(`\n[checkArbitrage] Starting iteration ${iterationCount + 1}`);
    const opportunities = [];
    const balances = await getBalances();
    console.log('[checkArbitrage] Current balances:', balances);

    // Get all Proton pools (now cached)
    const protonPools = await fetchProtonPools();
    console.log(`[checkArbitrage] Found ${protonPools.length} Proton pools`);
    console.log('[checkArbitrage] Proton pools:', protonPools.map(p => `${p.tokenA}/${p.tokenB}`));

    // Check all tokens against XMD and stablecoins
    for (const token of tokens) {
      if (token === 'XMD' || stablecoins.includes(token)) continue;
      if (balances[token] <= 0) continue;

      console.log(`\n[checkArbitrage] Checking token ${token}`);

      // Check Proton pools for both XMD and XUSDC
      const protonPool = protonPools.find(p => 
        (p.tokenA === 'XUSDC' && p.tokenB === token) || 
        (p.tokenB === 'XUSDC' && p.tokenA === token) ||
        (p.tokenA === 'XMD' && p.tokenB === token) || 
        (p.tokenB === 'XMD' && p.tokenA === token)
      );

      if (protonPool) {
        // Determine which token is the source token (XMD or XUSDC)
        const sourceToken = protonPool.tokenA === 'XMD' || protonPool.tokenB === 'XMD' ? 'XMD' : 'XUSDC';
        console.log(`[checkArbitrage] Found Proton pool for ${token}/${sourceToken}`);
        const protonRate = getProtonRate(protonPool, sourceToken, token);
        console.log(`[checkArbitrage] Proton rate: ${protonRate}`);

        if (protonRate <= 0) {
          console.log(`[checkArbitrage] Invalid Proton rate, skipping`);
          continue;
        }

        // Check Alcor pools for both XMD and stablecoins
        console.log(`[checkArbitrage] Checking Alcor pools for ${token}`);
        const alcorRates = await Promise.all([
          getSwapRate(sourceToken, token),
          getSwapRate(token, sourceToken),  // Check reverse direction
          ...stablecoins.map(stablecoin => getSwapRate(stablecoin, token)),
          ...stablecoins.map(stablecoin => getSwapRate(token, stablecoin))  // Check reverse direction for stablecoins
        ]);

        // Use the first valid rate found for each pair
        const validRates = {
          [sourceToken]: alcorRates[0].rate > 0 ? alcorRates[0] : alcorRates[1],
          'XUSDC': alcorRates[2].rate > 0 ? alcorRates[2] : alcorRates[5],
          'XPYUSD': alcorRates[3].rate > 0 ? alcorRates[3] : alcorRates[6],
          'XPAX': alcorRates[4].rate > 0 ? alcorRates[4] : alcorRates[7]
        };

        console.log(`[checkArbitrage] Alcor rates for ${token}:`, validRates);

        // Compare Proton rate with all Alcor rates
        for (const [compareToken, rate] of Object.entries(validRates)) {
          if (rate.rate > 0) {
            console.log(`[checkArbitrage] Comparing rates for ${compareToken}->${token}:`);
            console.log(`[checkArbitrage] Proton rate: ${protonRate}`);
            console.log(`[checkArbitrage] Alcor rate: ${rate.rate}`);
            
            // Calculate profit potential
            const profit = protonRate > rate.rate 
              ? (protonRate / rate.rate) - 1  // Proton->Alcor profit
              : (rate.rate / protonRate) - 1; // Alcor->Proton profit
            
            console.log(`[checkArbitrage] Potential profit: ${profit * 100}%`);
            
            if (profit > 0.0001) {
              console.log(`[checkArbitrage] Found profitable arbitrage opportunity: ${compareToken}->${token}`);
              
              // Set amount to 1 dollar in a stablecoin
              const opportunityAmount = 1.0; // 1 dollar

              // Calculate expected profit based on the amount and direction
              const expectedProfit = profit * opportunityAmount;
              const direction = protonRate > rate.rate ? 'PROTON_TO_ALCOR' : 'ALCOR_TO_PROTON';
              
              if (stablecoins.includes(compareToken) && stablecoins.includes(token)) continue;
              
              opportunities.push({
                type: direction,
                sourceToken: compareToken,
                targetToken: token,
                amount: opportunityAmount,
                protonRate,
                alcorRate: rate.rate,
                expectedProfit,
                protonPool
              });
            } else {
              console.log(`[checkArbitrage] Profit too small, skipping`);
            }
          } else {
            console.log(`[checkArbitrage] No Alcor pool found for ${compareToken}->${token}`);
          }
        }
      } else {
        console.log(`[checkArbitrage] No Proton pool found for ${token}/XMD or ${token}/XUSDC`);
      }
    }

    if (opportunities.length === 0) {
      console.log('[checkArbitrage] No arbitrage opportunities found. Waiting for next check...');
      await new Promise(resolve => setTimeout(resolve, 555));
      iterationCount++;
      continue;
    }

    console.log(`[checkArbitrage] Found ${opportunities.length} opportunities`);
    // Sort by expected profit
    opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit);

    // Execute opportunities with rapid-fire
    for (const opportunity of opportunities) {
      const opportunityId = `${opportunity.sourceToken}_${opportunity.targetToken}`;
      if (failedOpportunities.has(opportunityId)) {
        console.log(`[checkArbitrage] Skipping failed opportunity: ${opportunityId}`);
        continue;
      }

      console.log(`\n[checkArbitrage] Executing opportunity: ${opportunity.sourceToken}->${opportunity.targetToken}`);
      console.log(`[checkArbitrage] Amount: ${opportunity.amount}, Expected Profit: ${opportunity.expectedProfit}`);
      console.log(`[checkArbitrage] Proton rate: ${opportunity.protonRate}, Alcor rate: ${opportunity.alcorRate}`);

      const success = await executeArbitrageUnified({
        from: opportunity.sourceToken,
        to: opportunity.targetToken,
        amount: opportunity.amount,
        protonPool: opportunity.protonPool,
        isProtonToAlcor: opportunity.protonRate > opportunity.alcorRate
      });

      if (!success) {
        console.log(`[checkArbitrage] Opportunity failed: ${opportunityId}`);
        failedOpportunities.add(opportunityId);
      } else {
        console.log(`[checkArbitrage] Opportunity executed successfully`);
      }
    }

    iterationCount++;
    await new Promise(resolve => setTimeout(resolve, 555));
  } while (true);
}

// Execute arbitrage in a single transaction with proper conversions and profit verification
async function executeArbitrageUnified({ from, to, amount, protonPool, isProtonToAlcor }) {
  try {
    // Start with the initial amount
    let currentAmount = amount;
    let success = false;
    let attempts = 0;
    const maxAttempts = 5;
    let initialAmount = currentAmount; // Update initial amount on each retry
    let finalExpectedAmount = 0;
    let expectedProfit = 0;

    while (!success && attempts < maxAttempts) {
      initialAmount = currentAmount; // Ensure reported initial amount matches the amount being sent
      try {
        const actions = [];
        let expectedOut = 0;

        if (isProtonToAlcor) {
          // Proton to Alcor arbitrage
          // Step 1: Convert to XMD if starting with a stablecoin
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
            // After conversion to XMD, use XMD as the input for the next step
            from = 'XMD';
          }

          // Step 2: Swap on Proton (from XMD or original token to target token)
          const protonRate = getProtonRate(protonPool, from, to);
          if (protonRate <= 0) {
            throw new Error(`Invalid Proton rate for ${from} to ${to}`);
          }
          expectedOut = currentAmount * protonRate;
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

          // Step 3: Swap on Alcor (from target token back to original stablecoin or XMD)
          const tokenIn = new Token(tokenContracts[to], tokenPrecisions[to], to);
          const tokenOut = new Token(tokenContracts[from], tokenPrecisions[from], from);
          const amountIn = CurrencyAmount.fromRawAmount(tokenIn, Math.floor(expectedOut * Math.pow(10, tokenPrecisions[to])));
          const { trade, route } = await findBestSwapRoute(amountIn, tokenOut);
          const minReceivedAlcor = trade.outputAmount.toFixed(tokenPrecisions[from]);
          finalExpectedAmount = parseFloat(minReceivedAlcor);
          expectedProfit = finalExpectedAmount - initialAmount;
          // Check if expected profit is negative; if so, do not proceed
          if (expectedProfit < 0) {
            console.log(`Negative expected profit (${expectedProfit}). Skipping transaction.`);
            return false;
          }
          const memo = `swapexactin#${route.join(',')}#${curr_actor}#${initialAmount.toFixed(tokenPrecisions[from])} ${from}@${tokenContracts[from]}#0`;
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

          // Step 4: Convert back to original stablecoin if needed
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
            finalExpectedAmount = parseFloat(minReceivedAlcor); // Since redeem is 1:1, expected amount remains the same
            expectedProfit = finalExpectedAmount - initialAmount;
            // Check if expected profit is negative after conversion; if so, do not proceed
            if (expectedProfit < 0) {
              console.log(`Negative expected profit after conversion (${expectedProfit}). Skipping transaction.`);
              return false;
            }
          }
        } else {
          // Alcor to Proton arbitrage
          // Step 1: Swap on Alcor (from stablecoin or XMD to target token)
          const tokenIn = new Token(tokenContracts[from], tokenPrecisions[from], from);
          const tokenOut = new Token(tokenContracts[to], tokenPrecisions[to], to);
          const amountIn = CurrencyAmount.fromRawAmount(tokenIn, Math.floor(currentAmount * Math.pow(10, tokenPrecisions[from])));
          const { trade, route } = await findBestSwapRoute(amountIn, tokenOut);
          const minReceivedAlcor = trade.outputAmount.toFixed(tokenPrecisions[to]);
          const memo = `swapexactin#${route.join(',')}#${curr_actor}#${initialAmount.toFixed(tokenPrecisions[to])} ${to}@${tokenContracts[to]}#0`;
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

          // Step 2: Convert to XMD if target token is not XMD
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

          // Step 3: Swap on Proton (from target token or XMD back to original stablecoin)
          const protonRate = getProtonRate(protonPool, intermediateToken, from);
          if (protonRate <= 0) {
            throw new Error(`Invalid Proton rate for ${intermediateToken} to ${from}`);
          }
          expectedOut = parseFloat(minReceivedAlcor) * protonRate;
          finalExpectedAmount = expectedOut;
          expectedProfit = finalExpectedAmount - initialAmount;
          // Check if expected profit is negative; if so, do not proceed
          if (expectedProfit < 0) {
            console.log(`Negative expected profit (${expectedProfit}). Skipping transaction.`);
            return false;
          }
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

          // Step 4: Convert back to original stablecoin if needed
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
            finalExpectedAmount = expectedOut; // Since redeem is 1:1, expected amount remains the same
            expectedProfit = finalExpectedAmount - initialAmount;
            // Check if expected profit is negative after conversion; if so, do not proceed
            if (expectedProfit < 0) {
              console.log(`Negative expected profit after conversion (${expectedProfit}). Skipping transaction.`);
              return false;
            }
          }
        }

        // Log the exact transaction details with expected profit
        console.log('\n=== TRANSACTION DETAILS ===');
        console.log('Direction:', isProtonToAlcor ? 'Proton->Alcor' : 'Alcor->Proton');
        console.log('Initial Amount:', initialAmount);
        console.log('Expected Final Amount:', finalExpectedAmount);
        console.log('Expected Profit:', expectedProfit);
        console.log('Actions:', JSON.stringify(actions, null, 2));
        console.log('Transaction Config:', {
          blocksBehind: 3,
          expireSeconds: 30
        });

        // Execute batch transaction
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
        // Halve the amount and retry
        currentAmount *= 0.5;
      }
      attempts++;
    }

    return success;
  } catch (error) {
    console.error(`Arbitrage ${from}->${to} failed:`, error);
    return false;
  }
}

// Add the necessary imports and functions from arbitrage-xpr.js for routing
async function findBestSwapRoute(amountIn, tokenOut) {
  console.log(`[findBestSwapRoute] Routing ${amountIn.toExact()} -> ${tokenOut.symbol}`);

  try {
    // 1. Fetch all pools' basic data
    const allPools = await fetchAllPoolsBasic();

    // 2. Filter to relevant pools (both tokens in XMD or stablecoins or the target token)
    const tokensOfInterest = ['XMD', 'XUSDC', 'XPYUSD', 'XPAX', tokenOut.symbol, amountIn.currency.symbol];
    const relevantPools = allPools.filter(p =>
      tokensOfInterest.includes(p.tokenA.symbol) && tokensOfInterest.includes(p.tokenB.symbol)
    );
    console.log(`Found ${relevantPools.length} relevant pools`);

    // 3. Fetch ticks for these pools
    const poolsWithTicks = await Promise.all(
      relevantPools.map(async (p) => {
        const ticks = await rpc.get_table_rows({
          code: SWAP_CONTRACT,
          scope: p.id.toString(),
          table: 'ticks',
          limit: 1000
        });

        if (ticks.rows.length === 0) {
          console.warn(`Pool ${p.id} has no ticks, skipping`);
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
    console.log(`Fetched ticks for ${poolsWithTicks.length} pools`);

    // 4. Compute all possible routes (max length 2)
    const validRoutes = computeAllRoutes(amountIn.currency, tokenOut, poolsWithTicks, 2);
    console.log(`Found ${validRoutes.length} possible routes`);

    if (validRoutes.length === 0) {
      throw new Error('No valid routes found');
    }

    // 5. Find the best trade
    const [bestTrade] = Trade.bestTradeExactIn(validRoutes, amountIn, 1);
    if (!bestTrade) {
      throw new Error('No profitable trade found');
    }

    return {
      trade: bestTrade,
      route: bestTrade.route.pools.map(p => p.id)
    };
  } catch (error) {
    console.error(`Route finding error: ${error.message}`);
    throw error;
  }
}

async function fetchAllPoolsBasic() {
  console.log('[fetchAllPoolsBasic] Fetching basic pool data');
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
      ticks: [] // Empty ticks for initial calculation
    })));

    more = response.more;
    lower_bound = response.next_key;
  }

  return pools;
}

// Main execution
(async () => {
  // console.log('[Main] Starting arbitrage job...');
  try {
    await checkArbitrage();
    // console.log('[Main] Arbitrage job completed successfully');
    process.exit(0);
  } catch (error) {
    // console.error('[Main] Arbitrage job failed:', error);
    process.exit(1);
  }
})();


