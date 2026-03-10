//process.exit(1);

const { Api, JsonRpc } = require('eosjs');
const fetch = require('node-fetch');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { Token, Pool, CurrencyAmount, Trade, Percent, computeAllRoutes } = require('@alcorexchange/alcor-swap-sdk');
const { asset } = require('eos-common');
const { log } = require('node:console');

const privateKeys = [process.env.FREE_LOVE];
const signatureProvider = new JsSignatureProvider(privateKeys);
const rpc = new JsonRpc('https://proton.greymass.com', { fetch });
const api = new Api({ rpc, signatureProvider });

const stablecoins = ['XUSDC', 'XPYUSD', 'XPAX'];
const xmdContract = 'xmd.token';
const xtokensContract = 'xtokens';
const xmdTreasuryContract = 'xmd.treasury';
const curr_actor = '2apes'; 
// console.log("Starting arbitrage checks for account:", curr_actor);

// Add these constants
const SWAP_CONTRACT = 'swap.alcor';

// Update token precision constants
const XMD_PRECISION = 6;
const STABLECOIN_PRECISION = 6;

function parseToken(tokenData) {
  const quantity = asset(tokenData.quantity);
  return new Token(
    tokenData.contract,
    quantity.symbol.precision(),
    quantity.symbol.code().to_string(),
    `${quantity.symbol.code().to_string()}-${tokenData.contract}`.toLowerCase()
  );
}

async function getSwapRate(fromTokenSymbol, toTokenSymbol) {
  // console.log(`\n[getSwapRate] Checking ${fromTokenSymbol} -> ${toTokenSymbol} rate`);
  try {
    let pools = [];
    let more = true;
    let lower_bound = '';

    // Fetch all pools using pagination
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

    // console.log(`Fetched ${pools.length} pools from Alcor`);

    // Find pool containing both tokens
    const poolData = pools.find(p => {
      const symbols = [p.tokenA, p.tokenB].map(t => 
        asset(t.quantity).symbol.code().to_string()
      );
      return symbols.includes(fromTokenSymbol) && symbols.includes(toTokenSymbol);
    });

    if (!poolData) {
      // console.log(`Pool ${fromTokenSymbol}/${toTokenSymbol} not found`);
      return 0;
    }

    // Create Pool instance
    const pool = new Pool({
      ...poolData,
      tokenA: parseToken(poolData.tokenA),
      tokenB: parseToken(poolData.tokenB),
      sqrtPriceX64: poolData.currSlot.sqrtPriceX64,
      tickCurrent: poolData.currSlot.tick
    });

    // Determine which token is which in the pool
    const fromToken = [pool.tokenA, pool.tokenB].find(t => t.symbol === fromTokenSymbol);
    const toToken = [pool.tokenA, pool.tokenB].find(t => t.symbol === toTokenSymbol);

    if (!fromToken || !toToken) {
      // console.log('Token mismatch in pool');
      return 0;
    }

    // Calculate price as toToken per fromToken (direct pool price)
    const fromTokenIsA = fromToken.equals(pool.tokenA);
    const price = fromTokenIsA 
      ? pool.tokenAPrice.toFixed(6)  // toToken is tokenB, price is tokenB per tokenA
      : pool.tokenBPrice.toFixed(6); // toToken is tokenA, price is tokenA per tokenB

    // console.log(`1 ${fromTokenSymbol} = ${price} ${toTokenSymbol}`);
    return parseFloat(price);

  } catch (error) {
    // console.error('Swap rate calculation error:', error);
    return 0;
  }
}

async function balanceTokens() {
  // console.log('[balanceTokens] Balancing token amounts');

  const balances = await getBalances();
  const stablecoins = ['XUSDC', 'XPYUSD', 'XPAX'];

  // Check if all token balances are 1 or greater
  const allBalancesSufficient = stablecoins.every(stablecoin => balances[stablecoin] >= 1) && balances['XMD'] >= 1;

  if (allBalancesSufficient) {
    // console.log('All token balances are 1 or greater. No need to balance.');
    return; // Exit the function early
  }

  // Step 1: Convert all stablecoins to XMD
  for (const stablecoin of stablecoins) {
    const amount = balances[stablecoin];
    if (amount > 0) {
      // console.log(`Minting ${amount} ${stablecoin} to XMD`);
      await api.transact({
        actions: [{
          account: 'xtokens',
          name: 'transfer',
          authorization: [{ actor: curr_actor, permission: 'active' }],
          data: {
            from: curr_actor,
            to: xmdTreasuryContract,
            quantity: `${amount.toFixed(6)} ${stablecoin}`,
            memo: 'mint'
          }
        }]
      }, {
        blocksBehind: 3,
        expireSeconds: 30,
      });
    }
  }

  // Refresh balances after minting
  const updatedBalances = await getBalances();
  const totalXmdBalance = updatedBalances['XMD'];

  // Step 2: Divide total XMD balance by 4
  const amountPerStablecoin = totalXmdBalance / 4;
  // console.log(`Total XMD balance: ${totalXmdBalance.toFixed(6)}, Redeeming ${amountPerStablecoin.toFixed(6)} to each stablecoin`);

  // Step 3: Redeem 1/4 of total XMD balance into each stablecoin
  for (const stablecoin of stablecoins) {
    // console.log(`Redeeming ${amountPerStablecoin.toFixed(6)} XMD to ${stablecoin}`);
    await api.transact({
      actions: [{
        account: 'xmd.token',
        name: 'transfer',
        authorization: [{ actor: curr_actor, permission: 'active' }],
        data: {
          from: curr_actor,
          to: xmdTreasuryContract,
          quantity: `${amountPerStablecoin.toFixed(6)} XMD`,
          memo: `redeem,${stablecoin}`
        }
      }]
    }, {
      blocksBehind: 3,
      expireSeconds: 30,
    });
  }

  // console.log('[balanceTokens] Balancing complete');
}

async function checkArbitrage() {
  const failedOpportunities = new Set(); // Track failed opportunities
  const maxIterations = 22; // Maximum number of iterations
  let iterationCount = 0; // Initialize iteration counter

  // Run the balancer on the first iteration
  if (iterationCount === 0) {
    // console.log('Running balancer on the first iteration.');
    await balanceTokens();
  }
  
  do {
    // Check for exit conditions at the start of the loop
    if (iterationCount >= maxIterations) {
      // console.log(`Reached maximum iteration limit of ${maxIterations}. Exiting.`);
      process.exit(0);
    }

    const opportunities = [];
    const balances = await getBalances();

    for (const stablecoin of stablecoins) {
      const [xmdToStableRate, stableToXmdRate] = await Promise.all([
        getSwapRate('XMD', stablecoin),  // How much stable we get per 1 XMD
        getSwapRate(stablecoin, 'XMD')   // How much XMD we get per 1 stable
      ]);

      // Calculate available amounts (minimum 0.000001)
      const maxXmdAvailable = balances.XMD;
      const maxStableAvailable = balances[stablecoin];

      // Define opportunity identifiers
      const sellXmdForStableId = `SELL_XMD_FOR_STABLE_${stablecoin}`;
      const sellStableForXmdId = `SELL_STABLE_FOR_XMD_${stablecoin}`;

      // Correct arbitrage directions:
      // 1. If we get more than 1 stable per XMD -> sell XMD for stable
      if (xmdToStableRate > 1.0001 && maxXmdAvailable > 0.01 && !failedOpportunities.has(sellXmdForStableId)) {
        opportunities.push({
          id: sellXmdForStableId,
          type: 'SELL_XMD_FOR_STABLE',
          stablecoin,
          amount: maxXmdAvailable,
          rate: xmdToStableRate,
          expectedProfit: (xmdToStableRate - 1) * maxXmdAvailable
        });
      }

      // 2. If we get more than 1 XMD per stable -> sell stable for XMD
      if (stableToXmdRate > 1.0001 && maxStableAvailable > 0.01 && !failedOpportunities.has(sellStableForXmdId)) {
        opportunities.push({
          id: sellStableForXmdId,
          type: 'SELL_STABLE_FOR_XMD',
          stablecoin,
          amount: maxStableAvailable,
          rate: stableToXmdRate,
          expectedProfit: (stableToXmdRate - 1) * maxStableAvailable
        });
      }
    }

    if (opportunities.length === 0) {
      // console.log('No arbitrage opportunities found. Exiting.');
      process.exit(0);
    }

    // Execute most profitable opportunity first
    opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit);
    
    for (const opportunity of opportunities) {
      // console.log(`Executing ${opportunity.type} with ${opportunity.amount.toFixed(6)} ${opportunity.stablecoin} (Expected profit: ${opportunity.expectedProfit.toFixed(6)})`);
      
      const params = opportunity.type === 'SELL_STABLE_FOR_XMD' 
        ? { from: opportunity.stablecoin, to: 'XMD', amount: opportunity.amount }
        : { from: 'XMD', to: opportunity.stablecoin, amount: opportunity.amount };

      try {
        await executeArbitrageDirection(params);
      } catch (error) {
        // console.error(`Arbitrage ${params.from}->${params.to} failed:`, error);
        if (error.message.includes('Received lower than min')) {
          failedOpportunities.add(opportunity.id); // Add to failed opportunities
        }
      }
    }

    iterationCount++; // Increment the iteration counter

  } while (true); // The loop will exit via process.exit(0) when conditions are met
}

async function getBalances() {
  // console.log('[getBalances] Fetching balances');
  const balances = {};
  
  // Check stablecoin balances
  for (const stablecoin of stablecoins) {
    const balance = await rpc.get_table_rows({
      code: 'xtokens',
      table: 'accounts',
      scope: curr_actor,
      limit: 1,
      lower_bound: stablecoin,
      upper_bound: stablecoin
    });
    balances[stablecoin] = balance.rows[0] ? parseFloat(balance.rows[0].balance.split(' ')[0]) : 0;
  }

  // Check XMD balance
  const xmdBalance = await rpc.get_table_rows({
    code: 'xmd.token',
    table: 'accounts',
    scope: curr_actor,
    limit: 1,
    lower_bound: 'XMD',
    upper_bound: 'XMD'
  });
  balances['XMD'] = xmdBalance.rows[0] ? parseFloat(xmdBalance.rows[0].balance.split(' ')[0]) : 0;

  return balances;
}

async function executeArbitrageDirection({ from, to, amount }) {
  try {
    // console.log(`\n[executeArbitrageDirection] Starting ${from} -> ${to} with ${amount}`);
    
    // Determine the correct contract for each token
    const fromContract = from === 'XMD' ? 'xmd.token' : 'xtokens';
    const toContract = to === 'XMD' ? 'xmd.token' : 'xtokens';

    const tokenIn = new Token(fromContract, 6, from);
    const tokenOut = new Token(toContract, 6, to);

    // console.log(`TokenIn: ${tokenIn.symbol}@${tokenIn.contract}`);
    // console.log(`TokenOut: ${tokenOut.symbol}@${tokenOut.contract}`);

    const amountIn = CurrencyAmount.fromRawAmount(tokenIn, Math.floor(amount * 10**6));
    // console.log(`Finding best route for ${amountIn.toExact()} ${from}...`);
    
    const { trade, route } = await findBestSwapRoute(amountIn, tokenOut);
    
    if (amount > 1) {
      amount = 1;
    }
    
    let minReceived = amount.toFixed(6);
    const memo = `swapexactin#${route.join(',')}#${curr_actor}#${minReceived} ${to}@${toContract}#0`;

    // Add detailed logging
    // console.log('\n=== TX DETAILS ===');
    // console.log('Route pools:', route);
    // console.log('From:', from);
    // console.log('To:', to);
    // console.log('Amount:', `${amount.toFixed(6)} ${from}`);
    // console.log('Minimum Received:', `${minReceived} ${to}`);
    // console.log('Memo:', memo);
    // console.log('Token Out Contract:', toContract);
    
    // Log the full transaction data
    const txData = {
      account: fromContract,
      name: 'transfer',
      authorization: [{ actor: curr_actor, permission: 'active' }],
      data: {
        from: curr_actor,
        to: SWAP_CONTRACT,
        quantity: `${amount.toFixed(6)} ${from}`,
        memo
      }
    };
    // console.log('Full TX data:', JSON.stringify(txData, null, 2));
    // console.log('===================\n');

    if (minReceived >= amount) {
      const swapResult = await api.transact({
        actions: [{
          account: fromContract,
          name: 'transfer',
          authorization: [{ actor: curr_actor, permission: 'active' }],
          data: {
            from: curr_actor,
            to: SWAP_CONTRACT,
            quantity: `${amount.toFixed(6)} ${from}`,
            memo
          }
        }]
      }, {
        blocksBehind: 3,
        expireSeconds: 30,
      });
    }

    // console.log(`Successfully swapped ${amount} ${from} to ${to}`);
    
    // Only execute redeem if we received XMD and swap was successful
    if (to === 'XMD' && swapResult.processed.receipt.status === 'executed') {
      // console.log('Initiating redeem transaction...');
      
      await api.transact({
        actions: [{
          account: 'xmd.token',
          name: 'transfer',
          authorization: [{ actor: curr_actor, permission: 'active' }],
          data: {
            from: curr_actor,
            to: xmdTreasuryContract,
            quantity: `${minReceived} XMD`,
            memo: `redeem,${from}`
          }
        }]
      }, {
        blocksBehind: 3,
        expireSeconds: 30,
      });
      
      // console.log(`Redeemed ${minReceived} XMD back to stablecoin`);
    }
    
  } catch (error) {
    // console.error(`Arbitrage ${from}->${to} failed:`, error);
  }
}

async function findBestSwapRoute(amountIn, tokenOut) {
  // console.log(`[findBestSwapRoute] Routing ${amountIn.toExact()} -> ${tokenOut.symbol}`);

  try {
    // 1. Fetch all pools' basic data
    const allPools = await fetchAllPoolsBasic();

    // 2. Filter to relevant pools (both tokens in XMD or stablecoins)
    const tokensOfInterest = ['XMD', 'XUSDC', 'XPYUSD', 'XPAX'];
    const relevantPools = allPools.filter(p =>
      tokensOfInterest.includes(p.tokenA.symbol) && tokensOfInterest.includes(p.tokenB.symbol)
    );
    // console.log(`Found ${relevantPools.length} relevant pools`);

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
          // console.warn(`Pool ${p.id} has no ticks, skipping`);
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
    // console.log(`Fetched ticks for ${poolsWithTicks.length} pools`);

    // 4. Compute all possible routes (max length 2)
    const validRoutes = computeAllRoutes(amountIn.currency, tokenOut, poolsWithTicks, 2);
    // console.log(`Found ${validRoutes.length} possible routes`);

    if (validRoutes.length === 0) {
      throw new Error('No valid routes found');
    }

    // 5. Find the best trade
    const [bestTrade] = Trade.bestTradeExactIn(validRoutes, amountIn, 1);
    if (!bestTrade) {
      throw new Error('No profitable trade found');
    }

    // 6. Log the best trade path - FIX THE ERROR HERE
    // console.log('Best trade path:');
    
    // Safely log the path - check structure first
    if (bestTrade.route && bestTrade.route.path) {
      // bestTrade.route.path.forEach(token => console.log(`- ${token.symbol}`));
    } else if (bestTrade.route && bestTrade.route.tokenPath) {
      // bestTrade.route.tokenPath.forEach(token => console.log(`- ${token.symbol}`));
    } else {
      // Log the route structure to understand what's available
      // console.log('Route structure:', JSON.stringify(bestTrade.route, (key, value) => {
      //   if (key === 'ticks' || key === 'pools') return '[Array]';
      //   return value;
      // }, 2));
      
      // Log tokens involved in the route
      // console.log('Input token:', amountIn.currency.symbol);
      // console.log('Output token:', tokenOut.symbol);
      
      // Log pool IDs in the route
      if (bestTrade.route && bestTrade.route.pools) {
        // console.log('Route pools:', bestTrade.route.pools.map(p => p.id));
      }
    }

    return {
      trade: bestTrade,
      route: bestTrade.route.pools.map(p => p.id)
    };
  } catch (error) {
    // console.error(`Route finding error: ${error.message}`);
    throw error;
  }
}

async function fetchAllPoolsBasic() {
  // console.log('[fetchAllPoolsBasic] Fetching basic pool data');
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

async function fetchPoolsWithTicks(poolIds) {
  // console.log(`[fetchPoolsWithTicks] Fetching ${poolIds.length} relevant pools`);
  const validPools = [];
  
  for (const id of poolIds) {
    try {
      const pool = await rpc.get_table_rows({
        code: SWAP_CONTRACT,
        scope: SWAP_CONTRACT,
        table: 'pools',
        lower_bound: id,
        upper_bound: id,
        limit: 1
      }).then(r => r.rows[0]);

      if (!pool) {
        // console.warn(`Pool ${id} not found`);
        continue;
      }

      const ticks = await rpc.get_table_rows({
        code: SWAP_CONTRACT,
        scope: id.toString(),
        table: 'ticks',
        limit: 1000
      });

      if (ticks.rows.length === 0) {
        // console.warn(`Pool ${id} has no ticks, skipping`);
        continue;
      }

      validPools.push(new Pool({
        ...pool,
        tokenA: parseToken(pool.tokenA),
        tokenB: parseToken(pool.tokenB),
        sqrtPriceX64: pool.currSlot.sqrtPriceX64,
        tickCurrent: pool.currSlot.tick,
        ticks: ticks.rows.sort((a, b) => a.id - b.id)
      }));
    } catch (error) {
      // console.error(`Error processing pool ${id}:`, error);
    }
  }

  return validPools;
}

(async () => {
  try {
    await checkArbitrage();
    console.log('Arbitrage job completed successfully');
    process.exit(0);
  } catch (error) {
    // console.error('Arbitrage job failed:', error);
    process.exit(1);
  }
})(); 