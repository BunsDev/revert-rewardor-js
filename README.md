# rewardor-js

Script to calculate reward distribution for the Revert auto-compounder rewards. The output of this script is fed into https://github.com/Uniswap/merkle-distributor to create the merkle tree for claiming rewards

## How rewards are calculated

First we fetch all the compoundingSessions from the Revert Compoundor subgraph[1]. For each session we calculate the following values:

* **Compounded Value**: The summed ETH value of all compounded fees (using prices at each relevant block)
* **Fee Value**: The summed ETH value of all fees accrued while the position was in the auto-compounder contract during the reward period (using prices at each relevant block)

* **Vesting Factor** Vested fraction for the liquidity in the compounding session which generated the compounded value (see more details below)
* **Vested Compounded Value** We take the minimum of Compounded Value and Fee Value, so that fees generated prior to the rewards period are not included, and multiply that by the *Vesting Factor*. 


**MIN(Compounded Value,  Fee Value) * Vesting Factor.**  

Token prices at specific blocks are taken from the official Uniswap v3 subgraph.


## How time-vesting with changing liquidity works
Liquidity for a position can be increased or decreased while it is auto-compounding, so the calculation of vesting is done as follows:

We take each change in liquidity as a discrete **liquidity level** for which the following values are calculated:

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


[1] For Optimism: [revert-finance/compoundor-optimism](https://thegraph.com/hosted-service/subgraph/revert-finance/uniswap-v3-polygon)
