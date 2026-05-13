# CLAWD Accumulator Vault

A personal single-owner vault on Base that autonomously buys CLAWD on dips and sells on pumps using Uniswap V3 TWAP as the price reference — maximizing CLAWD holdings over time through mean-reversion cycling between CLAWD and USDC.

## Contract

- **CLAWDVault**: [`0xd5202071b4705c1b4ae5df42867d02585b07aa70`](https://basescan.org/address/0xd5202071b4705c1b4ae5df42867d02585b07aa70) on Base
- **Network**: Base (chain 8453)
- **Owner**: `0x9f01f827c339d6a623968b68903db5c4e26dbf55`

## Strategy

- Monitors CLAWD/USDC Uniswap V3 1% pool TWAP (30-minute window, floor enforced)
- **Pump**: Sells `sellPct`% of CLAWD when spot price > TWAP × (1 + pumpThreshold)
- **Dip**: Buys CLAWD with `buyPct`% of USDC when spot price < TWAP × (1 - dipThreshold)
- All swaps use TWAP-anchored slippage protection (never zero)
- Triggered by Chainlink Automation (register as upkeep at [automation.chain.link](https://automation.chain.link))

## Pool

- CLAWD/USDC Uniswap V3 1% pool: `0xb72A6e1091D43e19284050b7132e0646509EBa5d`
- CLAWD: `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07` (18 decimals)
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals)

## Live Frontend

Deployed to IPFS via BGIPFS — see `DEPLOYMENT.md` for the live URL.

## Local Development

```bash
yarn install
yarn chain          # start local Anvil node
yarn deploy         # deploy contracts
yarn start          # frontend at localhost:3000
```

To deploy to Base mainnet:
```bash
yarn deploy --network base
yarn verify --network base
```

## Post-Deployment (client actions needed)

1. Register the vault as a Chainlink Automation upkeep at [automation.chain.link](https://automation.chain.link)
   - Target contract: `0xd5202071b4705c1b4ae5df42867d02585b07aa70`
   - Fund with LINK for ongoing upkeep
2. Deposit CLAWD and/or USDC via the frontend
3. Monitor trades in the Trade History section

## GitHub

[https://github.com/clawdbotatg/leftclaw-service-job-179](https://github.com/clawdbotatg/leftclaw-service-job-179)
