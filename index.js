require('dotenv').config()
const ethers = require("ethers")
const axios = require('axios')
const fs = require('fs')
const BigDecimal = require('big.js')

// fix exp string formating for integer big decimals
BigDecimal.PE = 32
BigDecimal.NE = -32
BigDecimal.RM = 0 // round down always

const BigNumber = ethers.BigNumber

const IERC20_ABI = require("./contracts/IERC20.json")
const NPM_RAW = require("./contracts/INonfungiblePositionManager.json")
const FACTORY_RAW = require("./contracts/IUniswapV3Factory.json")
const POOL_RAW = require("./contracts/IUniswapV3Pool.json")

const provider = new ethers.providers.JsonRpcBatchProvider(process.env.RPC_URL)

const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
const factory = new ethers.Contract(factoryAddress, FACTORY_RAW.abi, provider)
const npmAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"
const npm = new ethers.Contract(npmAddress, NPM_RAW.abi, provider)
const compoundorAddress = "0x5411894842e610c4d0f6ed4c232da689400f94a1"

const network = process.env.NETWORK
const compoundorGraphApiUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/compoundor-" + network
const uniswapGraphApiUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-" + network

const priceCache = {}
const decimalsCache = {}
const symbolsCache = {}
const timestampCache = {}

const includeListTokens = process.env.INCLUDE_LIST_TOKENS.split(",").filter(i => i)
const includeListTokenPairs = process.env.INCLUDE_LIST_TOKEN_PAIRS.split(",").filter(i => i).map(p => ({ symbolA: p.split("/")[0], symbolB: p.split("/")[1] }))
const excludeListTokens = process.env.EXCLUDE_LIST_TOKENS.split(",").filter(i => i)

// add some fixed token prices because they are missing in the subgraph (small liquidity coins)
const fixedTokenPrices = {}
process.env.FIXED_TOKEN_PRICES.split(",").filter(i => i).forEach(p => fixedTokenPrices[p.split(":")[0].toLowerCase()] = BigDecimal(p.split(":")[1]))

// execute main function with configured env variables
run(parseInt(process.env.START_BLOCK), parseInt(process.env.END_BLOCK), parseInt(process.env.VESTING_PERIOD))

// main function which calculates reward distribution
async function run(startBlock, endBlock, vestingPeriod) {

    const allSessions = await getCompoundSessionsPaged(startBlock, endBlock)
    const sessionsGrouped = allSessions.reduce((group, session) => {
        group[session.token.id] = group[session.token.id] ?? []
        group[session.token.id].push(session)
        return group
      }, {})

    // read from file if temp progress
    const positions = fs.existsSync(process.env.TEMP_FILE_NAME) ? JSON.parse(fs.readFileSync(process.env.TEMP_FILE_NAME)) : {}
    // convert to bigdecimals
    Object.values(positions).forEach(p => p.amount = BigDecimal(p.amount))

    console.log("Processing", Object.keys(sessionsGrouped).length - Object.keys(positions).length, "positions")

    // create table of all valid compounded amounts per account / per position
    for (const tokenId in sessionsGrouped) {
        const sessions = sessionsGrouped[tokenId]

        // skip already calculated
        if (positions[tokenId]) {
            continue;
        }

        const data = await calculatePositionData(sessions, startBlock, endBlock, vestingPeriod)
        positions[tokenId] = { id: tokenId, account: sessions[sessions.length - 1].account, symbol0: data.symbol0, symbol1: data.symbol1, amount: data.amount, fee: data.position.fee }

        fs.writeFileSync(process.env.TEMP_FILE_NAME, JSON.stringify(positions))
    }

    const accounts = {}
    for (const position of Object.values(positions)) {
        if (!accounts[position.account]) {
            accounts[position.account] = position.amount
        } else {
            accounts[position.account] = accounts[position.account].plus(position.amount)
        }
    }

    // calculate proportional amounts of reward
    const totalReward = BigDecimal(process.env.TOTAL_REWARD)
    const totalRewardDigits = 18
    
    const total = Object.values(accounts).reduce((a, c) => a.plus(c), BigDecimal(0))
    const finalRewards = Object.entries(accounts).map(([account, amount]) => (
        {
            account,
            reward: BigNumber.from(totalReward.times(amount.div(total)).round(0, 0).toString())
        })).filter(x => x.reward.gt(0))

    // save table to file for position analysis
    const infoContent = Object.values(positions).sort((a, b) => a.amount.gt(b.amount) ? -1 : a.amount.lt(b.amount) ? 1 : 0).map(p => p.id + "," + p.symbol0 + "," + p.symbol1 + "," + p.fee + "," + p.account + "," + p.amount.toString() + "," + p.amount.div(total).mul(totalReward).div(BigDecimal(10).pow(totalRewardDigits)).toString()).join("\n")
    fs.writeFileSync(process.env.INFO_FILE_NAME, infoContent)

    // save json to file for merkle tree construction
    const content = {}
    finalRewards.forEach(r => content[r.account] = r.reward.toString())
    fs.writeFileSync(process.env.FILE_NAME, JSON.stringify(content))

    //fs.rmSync(process.env.TEMP_FILE_NAME)
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

    if (fixedTokenPrices[token]) {
        const prices = {}
        blocks.forEach(b => prices[b] = fixedTokenPrices[token])
        return prices
    }

    if (!priceCache[token]) {
        priceCache[token] = {}
    }

    const take = 100
    let result
    let missingBlocks = blocks.filter(b => !priceCache[token][b])
    let queries = missingBlocks.map(b => `price_${b}: token(block: { number: ${b}}, id: "${token}") { derivedETH }`)

    let start = 0
    while (start < queries.length) {
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

async function getCompoundSessionsPaged(from, to) {
    const sessions = []
    const take = 1000
    let result
    let currentFrom = 0
    do {
        result = await axios.post(compoundorGraphApiUrl, {
            query: `{
                compoundSessions(first: ${take}, where: { startBlockNumber_gte: ${currentFrom}, startBlockNumber_lt: ${to}}, orderBy: startBlockNumber, orderDirection: asc) {
                  id
                  startBlockNumber
                  endBlockNumber
                  account
                  token {
                    id
                  }
                }
              }`
        })

        if (result.data.data.compoundSessions.length == take) {
            currentFrom = parseInt(result.data.data.compoundSessions[result.data.data.compoundSessions.length - 1].startBlockNumber, 10) // paging by startBlockNumber number
        }

        for (const session of result.data.data.compoundSessions) {
            // do not add duplicates
            if (!sessions.find(s => s.id == session.id)) {
                sessions.push(session)
            }
        }

    } while (result.data.data.compoundSessions.length == take)

    return sessions.filter(x => x.endBlockNumber > from || !x.endBlockNumber)
}

async function calculateValueAtBlock(amount0, amount1, token0, token1, block) {

    const prices0 = await getTokenPricesAtBlocksPagedCached(token0, [block])
    const prices1 = await getTokenPricesAtBlocksPagedCached(token1, [block])
    const decimals0 = await getTokenDecimalsCached(token0)
    const decimals1 = await getTokenDecimalsCached(token1)

    if (prices0[block].eq(0)) {
        console.log("Price ZERO", token0)
    }
    if (prices1[block].eq(0)) {
        console.log("Price ZERO", token1)
    }

    return prices0[block].times(amount0.toString()).div(BigDecimal(10).pow(decimals0)).plus(prices1[block].times(amount1.toString()).div(BigDecimal(10).pow(decimals1)))
}

async function calculateLiquidityLevelsAndFees(nftId, position, pool, from, to) {

    const addFilter = npm.filters.IncreaseLiquidity(nftId)
    const withdrawFilter = npm.filters.DecreaseLiquidity(nftId)
    const collectFilter = npm.filters.Collect(nftId)

    const promises = []
    promises.push(provider.getLogs({ fromBlock: from, toBlock: to, ...addFilter}))
    promises.push(provider.getLogs({ fromBlock: from, toBlock: to, ...withdrawFilter}))
    promises.push(provider.getLogs({ fromBlock: from, toBlock: to, ...collectFilter}))
    const results = await Promise.all(promises)

    const adds = results[0] 
    const withdraws = results[1] 
    const collects = results[2] 

    console.log(adds.length, withdraws.length, collects.length)


    let addIndex = 0
    let withdrawIndex = 0
    let currentLiquidity = position.liquidity
    let currentBlock = from

    // collect all blocknumbers needed
    const blockNumbers = [from]
    while (addIndex < adds.length || withdrawIndex < withdraws.length) {
        const nextAdd = addIndex < adds.length ? adds[addIndex] : null
        const nextWithdraw = withdrawIndex < withdraws.length ? withdraws[withdrawIndex] : null
        let liquidity
        if (nextAdd && (!nextWithdraw || nextAdd.blockNumber <= nextWithdraw.blockNumber)) {
            liquidity = npm.interface.parseLog(nextAdd).args.liquidity
            addIndex++
            currentBlock = nextAdd.blockNumber
        } else {
            liquidity = npm.interface.parseLog(nextWithdraw).args.liquidity.mul(-1) // negate liquidity
            withdrawIndex++
            currentBlock = nextWithdraw.blockNumber
        }

        // for special case where liquidity goes from 0 to non0 or vice versa
        const fixedBlockNumber = currentLiquidity.add(liquidity).eq(0) ? currentBlock - 1 : (currentLiquidity.eq(0) ? currentBlock + 1 : currentBlock)
        blockNumbers.push(fixedBlockNumber)
        currentLiquidity = currentLiquidity.add(liquidity)
    }
    blockNumbers.push(to)

    // load data batched in the order needed
    let snapshotIndex = 0
    let timestampIndex = 0
    const snapshotCumulativesInsides = await Promise.all(blockNumbers.map(async bn => { 
        try { 
            return await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: bn } )
        } catch (err) { 
            console.log(err)
            return null 
        }
    }))
    const timestamps = await Promise.all(blockNumbers.map(getBlockTimestampCached))


    // calculate liquidities
    addIndex = 0
    withdrawIndex = 0
    currentLiquidity = position.liquidity
    currentBlock = from

    let lastSnap = snapshotCumulativesInsides[snapshotIndex++]
    let currentTimestamp = timestamps[timestampIndex++]

    let liquidityLevels = {}
    liquidityLevels[currentLiquidity] = { secondsInside: 0, totalSeconds: 0 }

    const feePromises = [
        npm.callStatic.collect([nftId, npmAddress, BigNumber.from(2).pow(128).sub(1), BigNumber.from(2).pow(128).sub(1)], { blockTag: from, from: compoundorAddress }),
        npm.callStatic.collect([nftId, npmAddress, BigNumber.from(2).pow(128).sub(1), BigNumber.from(2).pow(128).sub(1)], { blockTag: to, from: compoundorAddress })
    ]
    const feeResults = await Promise.all(feePromises)
    const initialFees = feeResults[0] 
    const finalFees = feeResults[1]

    const fees = {
        amount0: finalFees.amount0.sub(initialFees.amount0),
        amount1: finalFees.amount1.sub(initialFees.amount1)
    }

    for (const collect of collects) {
        fees.amount0 = fees.amount0.add(npm.interface.parseLog(collect).args.amount0)
        fees.amount1 = fees.amount1.add(npm.interface.parseLog(collect).args.amount1)
    }

    // process each increase and decrease liquidity event to build liquidity levels map
    while (addIndex < adds.length || withdrawIndex < withdraws.length) {
        const nextAdd = addIndex < adds.length ? adds[addIndex] : null
        const nextWithdraw = withdrawIndex < withdraws.length ? withdraws[withdrawIndex] : null
        let liquidity
        if (nextAdd && (!nextWithdraw || nextAdd.blockNumber <= nextWithdraw.blockNumber)) {
            liquidity = npm.interface.parseLog(nextAdd).args.liquidity
            addIndex++
            currentBlock = nextAdd.blockNumber
        } else {
            fees.amount0 = fees.amount0.sub(npm.interface.parseLog(nextWithdraw).args.amount0)
            fees.amount1 = fees.amount1.sub(npm.interface.parseLog(nextWithdraw).args.amount1)

            liquidity = npm.interface.parseLog(nextWithdraw).args.liquidity.mul(-1) // negate liquidity
            withdrawIndex++
            currentBlock = nextWithdraw.blockNumber
        }

        const timestamp = timestamps[timestampIndex++]
        const snap = snapshotCumulativesInsides[snapshotIndex++]
        if (lastSnap) {
            liquidityLevels[currentLiquidity].secondsInside += (2 ** 32 + snap.secondsInside - lastSnap.secondsInside) % 2 ** 32
            liquidityLevels[currentLiquidity].totalSeconds += timestamp - currentTimestamp
        }
        currentTimestamp = timestamp
        lastSnap = snap
        currentLiquidity = currentLiquidity.add(liquidity)
        if (!liquidityLevels[currentLiquidity]) {
            liquidityLevels[currentLiquidity] = { secondsInside: 0, totalSeconds: 0 }
        }
    }

    if (currentLiquidity.gt(0)) {
        const timestamp = timestamps[timestampIndex++]
        const snap = snapshotCumulativesInsides[snapshotIndex++]
        liquidityLevels[currentLiquidity].secondsInside += (2 ** 32 + snap.secondsInside - lastSnap.secondsInside) % 2 ** 32
        liquidityLevels[currentLiquidity].totalSeconds += timestamp - currentTimestamp
    }

    return { liquidityLevels, fees }
}

async function calculatePositionData(sessions, startBlock, endBlock, vestingPeriod) {

    let firstBlock = parseInt(sessions[0].startBlockNumber, 10)
    if (firstBlock < startBlock) {
        firstBlock = startBlock
    }

    // position at beginning of first session
    const position = await npm.positions(sessions[0].token.id, { blockTag: firstBlock })

    const symbol0 = await getTokenSymbolCached(position.token0)
    const symbol1 = await getTokenSymbolCached(position.token1)

    if (excludeListTokens.find(t => symbol0 == t || symbol1 == t)) {
        return { amount: BigDecimal(0), symbol0, symbol1, position }
    }
    if (includeListTokenPairs.length > 0 && !includeListTokenPairs.find(t => symbol0 == t.symbolA && symbol1 == t.symbolB || symbol1 == t.symbolA && symbol0 == t.symbolB)) {
        return { amount: BigDecimal(0), symbol0, symbol1, position }
    }
    if (includeListTokens.length > 0 && !includeListTokens.find(t => symbol0 == t || symbol1 == t)) {
        return { amount: BigDecimal(0), symbol0, symbol1, position }
    }

    const liquidityLevels = {}
    const fees = { amount0: BigNumber.from(0), amount1: BigNumber.from(0) }

    // merge liquidity levels and fees of all sessions
    for (const session of sessions) {
        const res = await calculateSessionLiquidityLevelsAndFees(session == sessions[0] ? position : null, session, startBlock, endBlock)
        for (const l in res.liquidityLevels) {
            if (liquidityLevels[l]) {
                liquidityLevels[l].secondsInside += res.liquidityLevels[l].secondsInside
                liquidityLevels[l].totalSeconds += res.liquidityLevels[l].totalSeconds
            } else {
                liquidityLevels[l] = res.liquidityLevels[l]
            }
        }
        fees.amount0 = fees.amount0.add(res.fees.amount0)
        fees.amount1 = fees.amount1.add(res.fees.amount1)
    }

    // calculate fair vesting factor considering vesting each liquidity level separately
    let vestedLiquidityTime = BigNumber.from(0)
    let totalLiquidityTime = BigNumber.from(0)

    const liquidities = Object.keys(liquidityLevels).map(BigNumber.from).sort((a, b) => a.eq(b) ? 0 : a.lt(b) ? -1 : 1)
    let previousLiquidity = BigNumber.from(0)
    for (const liquidity of liquidities) {
        const liquidityDelta = liquidity.sub(previousLiquidity)

        // calculate sum of secondinside and totalseconds from this level and all levels with higher liquidity
        const secondsInside = Object.entries(liquidityLevels).filter(ll => BigNumber.from(ll[0]).gte(liquidity)).reduce((acc, ll) => acc + ll[1].secondsInside, 0)
        const totalSeconds = Object.entries(liquidityLevels).filter(ll => BigNumber.from(ll[0]).gte(liquidity)).reduce((acc, ll) => acc + ll[1].totalSeconds, 0)

        vestedLiquidityTime = vestedLiquidityTime.add(liquidityDelta.mul(totalSeconds).mul(secondsInside >= vestingPeriod ? vestingPeriod : secondsInside).div(vestingPeriod))
        totalLiquidityTime = totalLiquidityTime.add(liquidityDelta.mul(totalSeconds))

        previousLiquidity = BigNumber.from(liquidity)
    }

    const vestingFactor = totalLiquidityTime.gt(0) ? BigDecimal(vestedLiquidityTime.toString()).div(BigDecimal(totalLiquidityTime.toString())) : BigDecimal(0)

    const generatedFees = await calculateValueAtBlock(fees.amount0, fees.amount1, position.token0, position.token1, endBlock)
    const amount = generatedFees.times(vestingFactor)

    // log to see progress
    console.log(sessions[0].token.id, amount.toString())

    return { amount, symbol0, symbol1, position }
}

async function calculateSessionLiquidityLevelsAndFees(position, session, startBlock, endBlock, retries = 0) {

    try {
        const from = parseInt(session.startBlockNumber, 10) < startBlock ? startBlock : parseInt(session.startBlockNumber, 10)
        const to = parseInt(session.endBlockNumber || ((endBlock + 1) + ""), 10) > endBlock ? endBlock : (parseInt(session.endBlockNumber, 10) - 1) // one block before removing from autocompounder - because of owner change
        const nftId = parseInt(session.token.id, 10)

        if (!position) {
            position = await npm.positions(session.token.id, { blockTag: from })
        }

        const poolAddress = await factory.getPool(position.token0, position.token1, position.fee, { blockTag: from })
        const pool = new ethers.Contract(poolAddress, POOL_RAW.abi, provider)

        return await calculateLiquidityLevelsAndFees(nftId, position, pool, from, to)
    } catch (err) {
        // retry handling for rare temporary errors from alchemy rpc endpoint
        console.log("Err retrying", session.token.id, err)
        if (retries < 3) {
            await new Promise(r => setTimeout(r, 30000 * (retries + 1))) // increasing delay
            return await calculateSessionLiquidityLevelsAndFees(position, session, startBlock, endBlock, retries + 1)
        } else {
            throw err
        }
    }
}