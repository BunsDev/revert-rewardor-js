require('dotenv').config()
const ethers = require("ethers");
const axios = require('axios');
const fs = require('fs');
const { MerkleTree } = require("merkletreejs");
const { keccak256 } = require('@ethersproject/keccak256');
const BigDecimal = require('big.js');
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

const whiteListTokens = process.env.WHITE_LIST_TOKENS.split(",").filter(i => i)
const whiteListTokenPairs = process.env.WHITE_LIST_TOKEN_PAIRS.split(",").filter(i => i).map(p => ({ symbolA: p.split("/")[0], symbolB: p.split("/")[1] }))
const blackListTokens = process.env.BLACK_LIST_TOKENS.split(",").filter(i => i)



// execute main function with configured env variables
run(parseInt(process.env.START_BLOCK), parseInt(process.env.END_BLOCK), parseInt(process.env.VESTING_PERIOD))

// main function which calculates reward distribution
async function run(startBlock, endBlock, vestingPeriod) {

    const sessions = await getCompoundSessionsPaged(startBlock, endBlock)

    const accounts = {}

    console.log("Processing", sessions.length, "Sessions")

    // create table of all valid compounded amounts per account
    for (const session of sessions) {
        const amount = await calculateMaxCompoundedETHForSession(session, startBlock, endBlock, vestingPeriod)
        if (!accounts[session.account]) {
            accounts[session.account] = amount
        } else {
            accounts[session.account] = accounts[session.account].plus(amount)
        }
    }

    // calculate proportional amounts of reward
    const totalReward = BigDecimal(process.env.TOTAL_REWARD)
    const total = Object.values(accounts).reduce((a, c) => a.plus(c), BigDecimal(0))
    const finalRewards = Object.entries(accounts).map(([account, amount]) => (
        {   
            account, 
            reward: BigNumber.from(totalReward.times(amount.div(total)).round(0, 0).toString())
        }))
    
    // calculate merkle root for resulting table
    const merkleTree = createMerkleTree(finalRewards)
    console.log(merkleTree.getHexRoot())

    // save table to file for reward UI usage
    const content = {}
    finalRewards.forEach(r => content[r.account] = r.reward.toString())
    fs.writeFileSync(process.env.FILE_NAME, JSON.stringify(content))
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
    let currentFrom = from
    do {
        result = await axios.post(graphApiUrl, {
            query: `{
                compoundSessions(first: ${take}, where: { endBlockNumber_gte: ${currentFrom}, startBlockNumber_lt: ${to}}, orderBy: endBlockNumber, orderDirection: asc) {
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
            currentFrom = parseInt(result.data.data.compoundSessions[result.data.data.compoundSessions.length - 1].endBlockNumber, 10) // paging by endBlockNumber number
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
  
    return sessions
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

async function getEstimatedFees(nftId, position, pool, from, to) {

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

    // if only one data point - get previous IncreaseLiquidity
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

    const blocks = [...new Set(adds.map(a => a.blockNumber).concat(withdraws.map(a => a.blockNumber).concat([to])))]
    const prices0 = await getTokenPricesAtBlocksPagedCached(position.token0, blocks)
    const prices1 = await getTokenPricesAtBlocksPagedCached(position.token1, blocks)
    const decimals0 = await getTokenDecimalsCached(position.token0)
    const decimals1 = await getTokenDecimalsCached(position.token1)

    let addIndex = 0
    let withdrawIndex = 0
    let currentBlock = from
    let currentLiquidity = position.liquidity
    
    let fees = BigDecimal(0)

    while (addIndex < adds.length || withdrawIndex < withdraws.length) {
        const nextAdd = addIndex < adds.length ? adds[addIndex] : null
        const nextWithdraw = withdrawIndex < withdraws.length ? withdraws[withdrawIndex] : null

        if (nextAdd && (!nextWithdraw || nextAdd.blockNumber <= nextWithdraw.blockNumber)) {
            const f = await calculateFees(currentBlock, nextAdd.blockNumber, avgFeeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
            fees = fees.plus(f)
            addIndex++
            currentBlock = nextAdd.blockNumber
            currentLiquidity = currentLiquidity.add(npm.interface.parseLog(nextAdd).args.liquidity)
        } else {
            const f = await calculateFees(currentBlock, nextWithdraw.blockNumber, avgFeeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
            fees = fees.plus(f)
            withdrawIndex++
            currentBlock = nextWithdraw.blockNumber
            currentLiquidity = currentLiquidity.sub(npm.interface.parseLog(nextWithdraw).args.liquidity)
        }
    }

    const f = await calculateFees(currentBlock, to, avgFeeGrowth, currentLiquidity, prices0, prices1, decimals0, decimals1)
    fees = fees.plus(f)

    return fees
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

async function getTimeInRange(position, pool, from, to) {
    const snapFrom = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: from })
    const snapTo = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: to })
    return (2 ** 32 + snapTo.secondsInside - snapFrom.secondsInside) % 2 ** 32
}

function createMerkleTree(finalRewards) {
    const leafNodes = finalRewards.map(f => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([ "address", "uint256" ], [ f.account, f.reward ])))
    return new MerkleTree(leafNodes, keccak256, { sort: true });
}

async function calculateMaxCompoundedETHForSession(session, startBlock, endBlock, vestingPeriod, retries = 0) {

    try {
        const from = parseInt(session.startBlockNumber, 10) < startBlock ? startBlock : parseInt(session.startBlockNumber, 10)
        const to = parseInt(session.endBlockNumber, 10) >= endBlock ? endBlock : parseInt(session.endBlockNumber, 10)
        const nftId = parseInt(session.token.id, 10)
        const position = await npm.positions(nftId, { blockTag: from });
    
        const symbol0 = await getTokenSymbolCached(position.token0)
        const symbol1 = await getTokenSymbolCached(position.token1)

        if (blackListTokens.find(t => symbol0 == t || symbol1 == t)) {
            return BigDecimal(0)
        }
        if (whiteListTokenPairs.length > 0 && !whiteListTokenPairs.find(t => symbol0 == t.symbolA && symbol1 == t.symbolB || symbol1 == t.symbolA && symbol0 == t.symbolB)) {
            return BigDecimal(0)
        }
        if (whiteListTokens.length > 0 && !whiteListTokens.find(t => symbol0 == t || symbol1 == t)) {
            return BigDecimal(0)
        }


        // get all compounded fees during reward period
        const compounds = session.compounds
    
        if (compounds.length > 0) {
             // get compounded and generated fees
            const compoundedFees = await getAutoCompoundedFees(position, compounds)
    
            const poolAddress = await factory.getPool(position.token0, position.token1, position.fee, { blockTag: from })
            const pool = new ethers.Contract(poolAddress, POOL_RAW.abi, provider)
    
            const generatedFees = await getEstimatedFees(nftId, position, pool, from,  to)
    
            const timeInRange = await getTimeInRange(position, pool, from, to)
    
            let amount = generatedFees && compoundedFees.gt(generatedFees) ? generatedFees : compoundedFees
    
            // apply vesting period
            if (timeInRange < vestingPeriod) {
                amount = amount.times(timeInRange).div(vestingPeriod)
            }

            console.log(nftId, amount.toString())
    
            return amount
        }
    
        return BigDecimal(0)
    } catch (err) {
        console.log("Err retrying", err)
        if (retries < 3) {
            await new Promise(r => setTimeout(r, 30000 * (retries + 1))) // increasing delay
            return await calculateMaxCompoundedETHForSession(session, startBlock, endBlock, vestingPeriod, retries + 1)
        } else {
            throw err
        }
    }
}