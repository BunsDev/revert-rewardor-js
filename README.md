# rewardor-js

Script to calculate reward distribution for revert auto-compoundor rewards. The output of this script is fed into https://github.com/Uniswap/merkle-distributor to create the merkle tree for rewards

## How rewards are calculated (short version)

* For each Uniswap v3 position all compounds which happened during the reward period are fetched
* **compoundETH** The sum of compounded tokens value is calculated (with token values in ETH at each compound)
* **feeETH** The amount of fees which were generated while the position was in the auto-compounder during the reward period is calculated (with token values in ETH at each liquidity change event)
* **vestingFactor** How much of the liquidity which generated fees is vested (see more details below)
* **vestedCompoundETH** MIN(compoundETH, feeETH) * vestingFactor is calculated

For each account all its positions **vestedCompoundETH** values are summed and divided by the sum of all positions **vestedCompoundETH** to calculate what fraction of the total reward pool it recieves.

Token prices at specific blocks are taken from the official Uniswap v3 subgraph.


## How time-vesting with changing liquidity works
Because meanwhile a position is auto-compounding, liquidity can be added and removed, the calculation of vesting is a bit more complicated.

For each level of liquidity the two values are calculated:

* **vestedLiquidityTime** as liquidity * total time * MIN(1, time in range / vesting period) 
* **totalLiquidityTime** as liquidity * total time.

*TODO: Illustration of liquidity levels and calculation*

**vestingFactor** is calculated as sum of vestedLiquidityTime / sum of totalLiquidityTime


## Getting Started

Before running the script create a .env config file with the keys from .env.example

Then:

```sh
npm install
node index.js
```