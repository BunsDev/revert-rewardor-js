require('dotenv').config()
const ethers = require("ethers");
const axios = require('axios');
const fs = require('fs');
const BigDecimal = require('big.js');

// fix exp string formating for integer big decimals
BigDecimal.PE = 32
BigDecimal.NE = -32

const BigNumber = ethers.BigNumber;

const IERC20_ABI = require("./contracts/IERC20.json")
const NPM_RAW = require("./contracts/INonfungiblePositionManager.json")
const FACTORY_RAW = require("./contracts/IUniswapV3Factory.json")
const POOL_RAW = require("./contracts/IUniswapV3Pool.json")

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)

const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
const factory = new ethers.Contract(factoryAddress, FACTORY_RAW.abi, provider)
const npmAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"
const npm = new ethers.Contract(npmAddress, NPM_RAW.abi, provider)

const network = process.env.NETWORK
const graphApiUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/compoundor-" + network
const uniswapGraphApiUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-" + network

const priceCache = {}
const decimalsCache = {}
const symbolsCache = {}
const timestampCache = {}

const includeListTokens = process.env.INCLUDE_LIST_TOKENS.split(",").filter(i => i)
const includeListTokenPairs = process.env.INCLUDE_LIST_TOKEN_PAIRS.split(",").filter(i => i).map(p => ({ symbolA: p.split("/")[0], symbolB: p.split("/")[1] }))
const excludeListTokens = process.env.EXCLUDE_LIST_TOKENS.split(",").filter(i => i)

// execute main function with configured env variables
run(parseInt(process.env.START_BLOCK), parseInt(process.env.END_BLOCK), parseInt(process.env.VESTING_PERIOD))

// main function which calculates reward distribution
async function run(startBlock, endBlock, vestingPeriod) {

    const sessions = await getCompoundSessionsPaged(startBlock, endBlock)

    const positions = {}
    const accounts = {}

    console.log("Processing", sessions.length, "Sessions")

    // create table of all valid compounded amounts per account / per position
    for (const session of sessions) {
        const data = await calculateSessionData(session, startBlock, endBlock, vestingPeriod)
        if (!accounts[session.account]) {
            accounts[session.account] = data.amount
        } else {
            accounts[session.account] = accounts[session.account].plus(data.amount)
        }
        if (!positions[session.token.id]) {
            positions[session.token.id] = { id: session.token.id, symbol0: data.symbol0, symbol1: data.symbol1, amount: data.amount, fee: data.position.fee }
        } else {
            positions[session.token.id].amount = positions[session.token.id].amount.plus(data.amount)
        }
    }

    // calculate proportional amounts of reward
    const totalReward = BigDecimal(process.env.TOTAL_REWARD)
    const total = Object.values(accounts).reduce((a, c) => a.plus(c), BigDecimal(0))
    const finalRewards = Object.entries(accounts).map(([account, amount]) => (
        {   
            account, 
            reward: BigNumber.from(totalReward.times(amount.div(total)).round(0, 0).toString())
        })).filter(x => x.reward.gt(0))

    // save table to file for position analysis
    const infoContent = Object.values(positions).map(p => p.id + "," + p.symbol0 + "," + p.symbol1 + "," + p.fee + "," + p.amount.toString()).join("\n")
    fs.writeFileSync(process.env.INFO_FILE_NAME, infoContent)

    // save json to file for merkle tree construction
    const content = {}
    finalRewards.forEach(r => content[r.account] = r.reward.toString())
    fs.writeFileSync(process.env.FILE_NAME, JSON.stringify(content))
}

async function getBlockTimestampCached(block) {
    if (!timestampCache[block]) {
        timestampCache[block] = (await provider.getBlock(block)).timestamp
    }
    return timestampCache[block]
}

async function getTokenDecimalsCached(token) {
    if (!decimalsCache[token]) {
        const contract = new ethers.Contract(token, IERC20_ABI, provider)
        decimalsCache[token] = await contract.decimals()
    }
    return decimalsCache[token]
}

async function getTokenSymbolCached(token) {
    if (!symbolsCache[token]) {
        const contract = new ethers.Contract(token, IERC20_ABI, provider)
        symbolsCache[token] = await contract.symbol()
    }
    return symbolsCache[token]
}

async function getTokenPricesAtBlocksPagedCached(token, blocks) {
    
    token = token.toLowerCase()

    if (!priceCache[token]) {
        priceCache[token] = {}
    }

    const take = 100
    let result
    let missingBlocks = blocks.filter(b => !priceCache[token][b])
    let queries = missingBlocks.map(b => `price_${b}: token(block: { number: ${b}}, id: "${token}") { derivedETH }`)

    let start = 0
    while(start < queries.length) {
        result = await axios.post(uniswapGraphApiUrl, {
            query: `{ ${queries.slice(start, start + take).join(" ")} }`  
        })
        Object.entries(result.data.data).forEach(([k, v]) => priceCache[token][k.substr(6)] = BigDecimal(v.derivedETH))
        start += take
    }

    const prices = {}
    blocks.forEach(b => prices[b] = priceCache[token][b])

    return prices
}

// in the case of sessions with too many compounds - do paging
async function getCompoundsPaged(sessionId, from, to) {
    const compounds = []
    const take = 1000
    let result

    do {
        result = await axios.post(graphApiUrl, {
            query: `{
                compoundSession(id: "${sessionId}") {
                  compounds(first:${take}, where: { blockNumber_gte: ${from}, blockNumber_lt: ${to}}, orderBy: blockNumber, orderDirection: asc) {
                    amountAdded0
                    amountAdded1
                    blockNumber
                    token0
                    token1
                  }
                }
              }`
        })
        compounds.push(...result.data.data.compoundSession.compounds)

        if (result.data.data.compoundSession.compounds.length == take) {
            from = parseInt(result.data.data.compoundSession.compounds[result.data.data.compoundSession.compounds.length - 1].blockNumber, 10) + 1 // paging by block number - assumes there is only one compound per block
        }
    } while (result.data.data.compoundSession.compounds.length == take)

    return compounds
}

async function getCompoundSessionsPaged(from, to) {
    const sessions = []
    const take = 1000
    let result
    let currentFrom = 0
    do {
        result = await axios.post(graphApiUrl, {
            query: `{
                compoundSessions(first: ${take}, where: { startBlockNumber_gte: ${currentFrom}, startBlockNumber_lt: ${to}}, orderBy: startBlockNumber, orderDirection: asc) {
                  id
                  startBlockNumber
                  endBlockNumber
                  account
                  token {
                    id
                  }
                  compounds(first:1000, where: { blockNumber_gte: ${from}, blockNumber_lt: ${to}}, orderBy: blockNumber, orderDirection: asc) {
                    amountAdded0
                    amountAdded1
                    blockNumber
                    token0
                    token1
                  }
                }
              }`
        })
        
        if (result.data.data.compoundSessions.length == take) {
            currentFrom = parseInt(result.data.data.compoundSessions[result.data.data.compoundSessions.length - 1].startBlockNumber, 10) // paging by startBlockNumber number
        }

        for (const session of result.data.data.compoundSessions) {
            if(session.compounds.length === 1000) {
                session.compounds = await getCompoundsPaged(session.id, from, to)
            }
            // do not add duplicates
            if (!sessions.find(s => s.id == session.id)) {
                sessions.push(session)
            }
        }
        
    } while (result.data.data.compoundSessions.length == take)
  


    return sessions.filter(x => x.endBlockNumber > from || !x.endBlockNumber )
}

async function averageFeeGrowthPerBlock(position, pool, from, to) {

    const positionKey = ethers.utils.solidityKeccak256([ "address", "int24", "int24" ], [ npmAddress, position.tickLower, position.tickUpper ])

    const fromData = await pool.positions(positionKey, { blockTag: from });
    const toData = await pool.positions(positionKey, { blockTag: to });

    let fee0 = toData.feeGrowthInside0LastX128.sub(fromData.feeGrowthInside0LastX128)
    if (fee0.lt(0)) {
        fee0 = fee0.add(BigNumber.from(2).pow(256))
    }
    let fee1 = toData.feeGrowthInside1LastX128.sub(fromData.feeGrowthInside1LastX128)
    if (fee1.lt(0)) {
        fee1 = fee1.add(BigNumber.from(2).pow(256))
    }
    fee0 = fee0.div(to - from)
    fee1 = fee1.div(to - from)

    return { fee0, fee1 }
}

async function calculateFees(from, to, avgFeeGrowth, liquidity, prices0, prices1, decimals0, decimals1) {
    
    const fees0 = avgFeeGrowth.fee0.mul(to - from).mul(liquidity).div(BigNumber.from(2).pow(128))
    const fees1 = avgFeeGrowth.fee1.mul(to - from).mul(liquidity).div(BigNumber.from(2).pow(128))
    return prices0[to].times(fees0.toString()).div(BigDecimal(10).pow(decimals0)).plus(prices1[to].times(fees1.toString()).div(BigDecimal(10).pow(decimals1)))
}
        
async function getGeneratedFeeAndVestingFactor(nftId, position, pool, from, to, vestingPeriod) {

    const addFilter = npm.filters.IncreaseLiquidity(nftId)
    const adds = await provider.getLogs({
        fromBlock: from,
        toBlock: to,
        ...addFilter
    })
    const withdrawFilter = npm.filters.DecreaseLiquidity(nftId)
    const withdraws = await provider.getLogs({
        fromBlock: from,
        toBlock: to,
        ...withdrawFilter
    })
 
    let firstBlock = (adds.length > 0 && (withdraws.length === 0 || adds[0].blockNumber < withdraws[0].blockNumber)) ? adds[0].blockNumber : (withdraws.length > 0 ? withdraws[0].blockNumber : null)
    const lastBlock = (adds.length > 0 && (withdraws.length === 0 || adds[adds.length - 1].blockNumber > withdraws[withdraws.length - 1].blockNumber)) ? adds[adds.length - 1].blockNumber : (withdraws.length > 0 ? withdraws[withdraws.length - 1].blockNumber : null)

    // if only one data point (compound) - get previous IncreaseLiquidity/DecreaseLiquidity event
    if (firstBlock == lastBlock) {
        const previousAdds = await provider.getLogs({
            fromBlock: 0,
            toBlock: from,
            ...addFilter
        })
        const previousWithdraws = await provider.getLogs({
            fromBlock: 0,
            toBlock: from,
            ...withdrawFilter
        })

        firstBlock = (previousAdds.length > 0 && (previousWithdraws.length === 0 || previousAdds[previousAdds.length - 1].blockNumber > previousWithdraws[previousWithdraws.length - 1].blockNumber)) ? previousAdds[previousAdds.length - 1].blockNumber : (previousWithdraws.length > 0 ? previousWithdraws[previousWithdraws.length - 1].blockNumber : null)
        if (!firstBlock || firstBlock == lastBlock) {
            throw Error("Could not estimate fee growth.")
        }
    }

    const avgFeeGrowth = await averageFeeGrowthPerBlock(position, pool, firstBlock, lastBlock)

    const blocks = [...new Set(adds.map(a => a.blockNumber).concat(withdraws.map(a => a.blockNumber).concat([to])))] // distinct block numbers
    const prices0 = await getTokenPricesAtBlocksPagedCached(position.token0, blocks)
    const prices1 = await getTokenPricesAtBlocksPagedCached(position.token1, blocks)
    const decimals0 = await getTokenDecimalsCached(position.token0)
    const decimals1 = await getTokenDecimalsCached(position.token1)

    let addIndex = 0
    let withdrawIndex = 0
    let currentBlock = from
    let currentTimestamp = await getBlockTimestampCached(currentBlock)
    let currentLiquidity = position.liquidity

    let lastSnap = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: currentBlock })
    
    let liquidityLevels = {}
    liquidityLevels[currentLiquidity] = { secondsInside: 0, totalSeconds: 0 } 

    let fees = BigDecimal(0)

    while (addIndex < adds.length || withdrawIndex < withdraws.length) {
        const nextAdd = addIndex < adds.length ? adds[addIndex] : null
        const nextWithdraw = withdrawIndex < withdraws.length ? withdraws[withdrawIndex] : null

        let f, l;
        let feeGrowth = avgFeeGrowth

        if (nextAdd && (!nextWithdraw || nextAdd.blockNumber <= nextWithdraw.blockNumber)) {
            if (currentBlock != from) {
                // uncomment for more exact fee growth calculation
                //feeGrowth = await averageFeeGrowthPerBlock(position, pool, currentBlock, nextAdd.blockNumber);
            }

            f = await calculateFees(currentBlock, nextAdd.blockNumber, feeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
            l = npm.interface.parseLog(nextAdd).args.liquidity
            addIndex++
            currentBlock = nextAdd.blockNumber
        } else {
            if (currentBlock != from) {
                // uncomment for more exact fee growth calculation
                //feeGrowth = await averageFeeGrowthPerBlock(position, pool, currentBlock, nextWithdraw.blockNumber);
            }

            f = await calculateFees(currentBlock, nextWithdraw.blockNumber, feeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
            l = npm.interface.parseLog(nextWithdraw).args.liquidity.mul(-1) // negate liquidity
            withdrawIndex++
            currentBlock = nextWithdraw.blockNumber
        }

        fees = fees.plus(f)
        const timestamp = await getBlockTimestampCached(currentBlock)

        // for special case where liquidity goes from 0 to non0 or vice versa
        const fixedBlockNumber = currentLiquidity.add(l).eq(0) ? currentBlock - 1 : (currentLiquidity.eq(0) ? currentBlock + 1 : currentBlock)

        const snap = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: fixedBlockNumber })
        liquidityLevels[currentLiquidity].secondsInside += (2 ** 32 + snap.secondsInside - lastSnap.secondsInside) % 2 ** 32
        liquidityLevels[currentLiquidity].totalSeconds += timestamp - currentTimestamp
        currentTimestamp = timestamp
        lastSnap = snap        
        currentLiquidity = currentLiquidity.add(l)
        if (!liquidityLevels[currentLiquidity]) {
            liquidityLevels[currentLiquidity] = { secondsInside: 0, totalSeconds: 0 }
        }
    }

    const f = await calculateFees(currentBlock, to, avgFeeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
    fees = fees.plus(f)

    if (currentLiquidity.gt(0)) {
        const timestamp = await getBlockTimestampCached(to)
        const snap = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: to })
        liquidityLevels[currentLiquidity].secondsInside += (2 ** 32 + snap.secondsInside - lastSnap.secondsInside) % 2 ** 32
        liquidityLevels[currentLiquidity].totalSeconds += timestamp - currentTimestamp
    }

    // calculate fair vesting factor considering vesting each liquidity level separately
    let vestedLiquidityTime = BigNumber.from(0)
    let totalLiquidityTime = BigNumber.from(0)

    const liquidities = Object.keys(liquidityLevels).map(BigNumber.from).sort((a, b) => a.eq(b) ? 0 : a.lt(b)? -1 : 1)
    let previousLiquidity = BigNumber.from(0)
    for (const liquidity of liquidities) {
        const liquidityDelta = liquidity.sub(previousLiquidity)
        const secondsInside = Object.entries(liquidityLevels).filter(ll => BigNumber.from(ll[0]).gte(liquidity)).reduce((acc, ll) => acc + ll[1].secondsInside, 0)
        const totalSeconds = Object.entries(liquidityLevels).filter(ll => BigNumber.from(ll[0]).gte(liquidity)).reduce((acc, ll) => acc + ll[1].totalSeconds, 0)
        
        vestedLiquidityTime = vestedLiquidityTime.add(liquidityDelta.mul(totalSeconds).mul(secondsInside >= vestingPeriod ? vestingPeriod : secondsInside).div(vestingPeriod))
        totalLiquidityTime = totalLiquidityTime.add(liquidityDelta.mul(totalSeconds))

        previousLiquidity = BigNumber.from(liquidity)
    }

    const vestingFactor = BigDecimal(vestedLiquidityTime.toString()).div(BigDecimal(totalLiquidityTime.toString()))

    return {
        generatedFees: fees,
        vestingFactor
    }
}

async function getAutoCompoundedFees(position, compounds) {
    let fees = BigDecimal(0)
    if (compounds.length > 0) {
        const blocks = compounds.map(c => c.blockNumber)
        const prices0 = await getTokenPricesAtBlocksPagedCached(position.token0, blocks)
        const prices1 = await getTokenPricesAtBlocksPagedCached(position.token1, blocks)
        const decimals0 = await getTokenDecimalsCached(position.token0)
        const decimals1 = await getTokenDecimalsCached(position.token1)

        for (const compound of compounds) {
            const amount0 = BigDecimal(compound.amountAdded0).div(BigDecimal(10).pow(decimals0))
            const amount1 = BigDecimal(compound.amountAdded1).div(BigDecimal(10).pow(decimals1))
            fees = fees.plus(prices0[compound.blockNumber].times(amount0).plus(prices1[compound.blockNumber].times(amount1)))
        }
    } 
    return fees
}

async function calculateSessionData(session, startBlock, endBlock, vestingPeriod, retries = 0) {

    try {
        const from = parseInt(session.startBlockNumber, 10) < startBlock ? startBlock : parseInt(session.startBlockNumber, 10)
        const to = parseInt(session.endBlockNumber || (endBlock + ""), 10) >= endBlock ? endBlock : parseInt(session.endBlockNumber, 10)
        const nftId = parseInt(session.token.id, 10)
        const position = await npm.positions(nftId, { blockTag: from });
    
        const symbol0 = await getTokenSymbolCached(position.token0)
        const symbol1 = await getTokenSymbolCached(position.token1)

        if (excludeListTokens.find(t => symbol0 == t || symbol1 == t)) {
            return BigDecimal(0)
        }
        if (includeListTokenPairs.length > 0 && !includeListTokenPairs.find(t => symbol0 == t.symbolA && symbol1 == t.symbolB || symbol1 == t.symbolA && symbol0 == t.symbolB)) {
            return BigDecimal(0)
        }
        if (includeListTokens.length > 0 && !includeListTokens.find(t => symbol0 == t || symbol1 == t)) {
            return BigDecimal(0)
        }

        // get all compounded fees during reward period
        const compounds = session.compounds
        
        let amount = BigDecimal(0)

        if (compounds.length > 0) {
             // get compounded and generated fees
            const compoundedFees = await getAutoCompoundedFees(position, compounds)
    
            const poolAddress = await factory.getPool(position.token0, position.token1, position.fee, { blockTag: from })
            const pool = new ethers.Contract(poolAddress, POOL_RAW.abi, provider)
    
            const data = await getGeneratedFeeAndVestingFactor(nftId, position, pool, from, to, vestingPeriod)

            // to be sure
            if (data.generatedFees.lt(0) || compoundedFees.lt(0)) {
                throw Error("Invalid fees for token: ", session.token.id)
            }

            amount = data.generatedFees && compoundedFees.gt(data.generatedFees) ? data.generatedFees : compoundedFees
            amount = amount.times(data.vestingFactor) // apply vesting period

            console.log(nftId, compounds.length, amount.toString())
        }
    
        return { amount, symbol0, symbol1, position }
    } catch (err) {
        console.log("Err retrying", session.token.id, err)
        if (retries < 3) {
            await new Promise(r => setTimeout(r, 30000 * (retries + 1))) // increasing delay
            return await calculateSessionData(session, startBlock, endBlock, vestingPeriod, retries + 1)
        } else {
            throw err
        }
    }
}