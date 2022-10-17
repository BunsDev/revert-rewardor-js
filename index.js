require('dotenv').config()
const ethers = require("ethers");
const axios = require('axios');
const fs = require('fs');
const { MerkleTree } = require("merkletreejs");
const { keccak256 } = require('@ethersproject/keccak256');

const BigNumber = ethers.BigNumber;

const IERC20_ABI = require("./contracts/IERC20.json")
const NPM_RAW = require("./contracts/INonfungiblePositionManager.json")
const FACTORY_RAW = require("./contracts/IUniswapV3Factory.json")
const POOL_RAW = require("./contracts/IUniswapV3Pool.json")

const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
const npmAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)

const factory = new ethers.Contract(factoryAddress, FACTORY_RAW.abi, provider)
const npm = new ethers.Contract(npmAddress, NPM_RAW.abi, provider)

const nativeTokenAddresses = {
    "mainnet": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "polygon": "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    "optimism": "0x4200000000000000000000000000000000000006",
    "arbitrum": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
}

const network = process.env.NETWORK
const nativeTokenAddress = nativeTokenAddresses[network]
const graphApiUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/compoundor-" + network

const pricePoolCache = {}

async function getCompoundSessions(from, to) {

    const sessions = []
    let skip = 0
    const take = 1000
    let result
    do {
        result = await axios.post(graphApiUrl, {
            query: `{
                compoundSessions(first: ${take}, skip: ${skip}, where: { endBlockNumber_gt: ${from}, startBlockNumber_lt: ${to}}) {
                  startBlockNumber
                  endBlockNumber
                  account
                  token {
                    id
                  }
                  compounds {
                      amountAdded0
                      amountAdded1
                    blockNumber
                    token0
                    token1
                  }
                }
              }`
        })
        skip += take
        sessions.push(...result.data.data.compoundSessions)
    } while (result.data.data.compoundSessions.length == take)
  
    return sessions
}

async function getTokenETHPricesX96(position, blockNumber) {

    const tokenPrice0X96 = await getTokenETHPriceX96(position.token0, blockNumber)
    const tokenPrice1X96 = await getTokenETHPriceX96(position.token1, blockNumber)

    if (tokenPrice0X96 && tokenPrice1X96) {
        return [tokenPrice0X96, tokenPrice1X96]
    } else if (tokenPrice0X96 || tokenPrice1X96) {
        // if only one has ETH pair - calculate other with pool price
        const poolAddress = await factory.getPool(position.token0, position.token1, position.fee, { blockTag: blockNumber });
        const poolContract = new ethers.Contract(poolAddress, POOL_RAW.abi, provider)
        const slot0 = await poolContract.slot0({ blockTag: blockNumber })
        const priceX96 = slot0.sqrtPriceX96.pow(2).div(BigNumber.from(2).pow(192 - 96))
        return [tokenPrice0X96 || tokenPrice1X96.mul(priceX96).div(BigNumber.from(2).pow(96)), tokenPrice1X96 || tokenPrice0X96.mul(BigNumber.from(2).pow(96)).div(priceX96)]
    } else {
        // TODO decide what to do here... should never happen
        throw Error("Couldn't find prices for position", position.token0, position.token1, position.fee)
    }
}

async function getTokenETHPriceX96(address, blockNumber) {
    if (address.toLowerCase() == nativeTokenAddress.toLowerCase()) {
        return BigNumber.from(2).pow(96);
    }


    let price = null

    const pricePool = await findPricePoolForToken(address, blockNumber)
    if (pricePool.address > 0) {
        const poolContract = new ethers.Contract(pricePool.address, POOL_RAW.abi, provider)
        const slot0 = await poolContract.slot0({ blockTag: blockNumber })
        if (slot0.sqrtPriceX96.gt(0)) {
            price = pricePool.isToken1WETH ? slot0.sqrtPriceX96.pow(2).div(BigNumber.from(2).pow(192 - 96)) : BigNumber.from(2).pow(192 + 96).div(slot0.sqrtPriceX96.pow(2))
        }
    }

    return price
}

async function findPricePoolForToken(address, blockNumber) {

    if (pricePoolCache[address]) {
        return pricePoolCache[address]
    }

    const minimalBalanceETH = BigNumber.from(10).pow(18) // 1 ETH
    let maxBalanceETH = BigNumber.from(0)
    let pricePoolAddress = null
    let isToken1WETH = null

    const nativeToken = new ethers.Contract(nativeTokenAddress, IERC20_ABI, provider)

    for (let fee of [100, 500, 3000, 10000]) {
        const candidatePricePoolAddress = await factory.getPool(address, nativeTokenAddress, fee, { blockTag: blockNumber })
        if (candidatePricePoolAddress > 0) {
            const poolContract = new ethers.Contract(candidatePricePoolAddress, POOL_RAW.abi, provider)

            const balanceETH = (await nativeToken.balanceOf(candidatePricePoolAddress, { blockTag: blockNumber }))
            if (balanceETH.gt(maxBalanceETH) && balanceETH.gte(minimalBalanceETH)) {
                pricePoolAddress = candidatePricePoolAddress
                maxBalanceETH = balanceETH
                if (isToken1WETH === null) {
                    isToken1WETH = (await poolContract.token1()).toLowerCase() == nativeTokenAddress.toLowerCase();
                }
            }
           
        }
    }

    pricePoolCache[address] = { address: pricePoolAddress, isToken1WETH }

    return pricePoolCache[address]
}

async function averageFeeGrowthPerBlock(position, pool, from, to) {

    const positionKey = ethers.utils.solidityKeccak256([ "address", "int24", "int24" ], [ npmAddress, position.tickLower, position.tickUpper ])

    const fromData = await pool.positions(positionKey, { blockTag: from });
    const toData = await pool.positions(positionKey, { blockTag: to });

    const fee0 = toData.feeGrowthInside0LastX128.sub(fromData.feeGrowthInside0LastX128).div(to - from)
    const fee1 = toData.feeGrowthInside1LastX128.sub(fromData.feeGrowthInside1LastX128).div(to - from)

    return { fee0, fee1 }
}

async function calculateFees(position, from, to, avgFeeGrowth, liquidity) {
    const prices = await getTokenETHPricesX96(position, to)
    const fees0 = avgFeeGrowth.fee0.mul(to - from).mul(liquidity).div(BigNumber.from(2).pow(128))
    const fees1 = avgFeeGrowth.fee1.mul(to - from).mul(liquidity).div(BigNumber.from(2).pow(128))
    return prices[0].mul(fees0).div(BigNumber.from(2).pow(96)).add(prices[1].mul(fees1).div(BigNumber.from(2).pow(96)))
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

    const firstBlock = (adds.length > 0 && (withdraws.length === 0 || adds[0].blockNumber < withdraws[0].blockNumber)) ? adds[0].blockNumber : (withdraws.length > 0 ? withdraws[0].blockNumber : null)
    const lastBlock = (adds.length > 0 && (withdraws.length === 0 || adds[adds.length - 1].blockNumber > withdraws[withdraws.length - 1].blockNumber)) ? adds[adds.length - 1].blockNumber : (withdraws.length > 0 ? withdraws[withdraws.length - 1].blockNumber : null)

    // TODO for now if only one data point - return null - fees cant be c
    if (firstBlock == lastBlock) {
        return null
    }

    const avgFeeGrowth = await averageFeeGrowthPerBlock(position, pool, firstBlock, lastBlock)

    let addIndex = 0
    let withdrawIndex = 0
    let currentBlock = from
    let currentLiquidity = position.liquidity
    
    let fees = BigNumber.from(0)

    while (addIndex < adds.length || withdrawIndex < withdraws.length) {
        const nextAdd = addIndex < adds.length ? adds[addIndex] : null
        const nextWithdraw = withdrawIndex < withdraws.length ? withdraws[withdrawIndex] : null

        if (nextAdd && (!nextWithdraw || nextAdd.blockNumber <= nextWithdraw.blockNumber)) {
            const f = await calculateFees(position, currentBlock, nextAdd.blockNumber, avgFeeGrowth, currentLiquidity)
            fees = fees.add(f)
            addIndex++
            currentBlock = nextAdd.blockNumber
            currentLiquidity = currentLiquidity.add(npm.interface.parseLog(nextAdd).args.liquidity)
        } else {
            const f = await calculateFees(position, currentBlock, nextWithdraw.blockNumber, avgFeeGrowth, currentLiquidity)
            fees = fees.add(f)
            withdrawIndex++
            currentBlock = nextWithdraw.blockNumber
            currentLiquidity = currentLiquidity.sub(npm.interface.parseLog(nextWithdraw).args.liquidity)
        }
    }

    const f = await calculateFees(position, currentBlock, to, avgFeeGrowth, currentLiquidity)
    fees = fees.add(f)

    return fees
}

async function getAutoCompoundedFees(position, compounds) {
    let fees = BigNumber.from(0)
    if (compounds.length > 0) {
        for (const compound of compounds) {
            const prices = await getTokenETHPricesX96(position, parseInt(compound.blockNumber, 10))
            fees = fees.add(prices[0].mul(compound.amountAdded0).div(BigNumber.from(2).pow(96)).add(prices[1].mul(compound.amountAdded1).div(BigNumber.from(2).pow(96))))
        }
    } 
    return fees
}

async function getTimeInRange(position, pool, from, to) {
    const snapFrom = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: from })
    const snapTo = await pool.snapshotCumulativesInside(position.tickLower, position.tickUpper, { blockTag: to })
    return (2 ** 32 + snapTo.secondsInside - snapFrom.secondsInside) % 2 ** 32
}

function createMerkleTree(accounts) {
    const leafNodes = Object.entries(accounts).map(val => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([ "address", "uint256" ], [ val[0], val[1] ])))
    // make sure its an even number - if not add dummy entry
    if (leafNodes.length % 2 === 1) {
        leafNodes.push(ethers.utils.defaultAbiCoder.encode([ "address", "uint256" ], [ ethers.constants.AddressZero, 0 ]))
    }
    return new MerkleTree(leafNodes, keccak256, { sort: true });
}

async function run(startBlock, endBlock, vestingPeriod) {

    const sessions = await getCompoundSessions(startBlock, endBlock)

    const accounts = {}

    console.log("Processing", sessions.length, "Sessions")

    for (const session of sessions) {
        const from = parseInt(session.startBlockNumber, 10) < startBlock ? startBlock : parseInt(session.startBlockNumber, 10)
        const to = parseInt(session.endBlockNumber, 10) >= endBlock ? endBlock : parseInt(session.endBlockNumber, 10)
        const nftId = parseInt(session.token.id, 10)
        const position = await npm.positions(nftId, { blockTag: from });

        // get all compounded fees during reward period
        const compounds = session.compounds.filter(c => c.blockNumber >= startBlock && c.blockNumber < endBlock)

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
                amount = amount.mul(timeInRange).div(vestingPeriod)
            }

            if (!accounts[session.account]) {
                accounts[session.account] = amount
            } else {
                accounts[session.account] = accounts[session.account].add(amount)
            }
        }
    }

    const merkleTree = createMerkleTree(accounts)
    console.log(merkleTree.getHexRoot())

    const content = Object.entries(accounts).map(val => val[0] + "," + val[1].toString()).join("\n")
    fs.writeFileSync(process.env.FILE_NAME, content)
}

run(parseInt(process.env.START_BLOCK), parseInt(process.env.END_BLOCK), parseInt(process.env.VESTING_PERIOD))
