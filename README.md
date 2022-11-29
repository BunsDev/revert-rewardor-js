# rewardor-js

Script to calculate reward distribution for the Revert auto-compounder rewards. The output of this script is fed into https://github.com/Uniswap/merkle-distributor to create the merkle tree for claiming rewards.

## How rewards are calculated

First we fetch all the compoundingSessions from the Revert Compoundor subgraph[1]. For each session we calculate the following values:

* **Fee Value**: The summed ETH value of all fees accrued while the position was in the auto-compounder contract during the reward period (using price of both tokens at the end of incentive period)

* **Vesting Factor**: Vested fraction for the liquidity in the compounding session which generated the compounded value (see more details below)
* **Vested Fee Value**: *Fee Value* multiplied that by the *Vesting Factor*. 

*Vested Fee Value* is summed by owner account of the compoundingSession and rewards are distributed proportionally to this sum.

TotalRewards enviroment variable defines the total reward amount to be distributed, and each account is assigned a proportional value of the rewards given their *Vested Fee Value* and the total sum of all other vested fee values.

Token prices are taken from the official Uniswap v3 subgraph except for special case handling for prices missing due to low liquidity pools.

## How time-vesting with changing liquidity works
Liquidity for a position can be increased or decreased while it is auto-compounding, so the calculation of vesting is done as follows:

We take each change in liquidity as a discrete **liquidity level** for which the following values are calculated:

* **vestedLiquidityTime** as liquidity * total time * MIN(1, time in range / vesting period) 
* **totalLiquidityTime** as liquidity * total time.

**vestingFactor** is calculated as sum of vestedLiquidityTime / sum of totalLiquidityTime


<img width="960" height="auto" alt="liquidity_vs_range2x" src="https://user-images.githubusercontent.com/21986/204597188-5e88fa9a-c564-438e-9aa0-01d3783bdfca.png">
<img width="960" height="auto" alt="vested_fraction2x" src="https://user-images.githubusercontent.com/21986/204597298-90f70602-6f36-47f6-a337-3ef3ee8fe76d.png">
<img width="960" height="auto" alt="vesting_factor2x" src="https://user-images.githubusercontent.com/21986/204597316-e1e3cf65-77ea-4930-b05f-f1ade7fb87b6.png">




## Getting Started

Before running the script create a .env config file with the keys from .env.example

Then:

```sh
npm install
node index.js

```


[1] For Optimism: [revert-finance/compoundor-optimism](https://thegraph.com/hosted-service/subgraph/revert-finance/uniswap-v3-optimism)
