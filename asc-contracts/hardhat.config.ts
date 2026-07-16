import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

// Real network wiring for the SMLYieldBond funding layer. `hardhat` (the
// default in-memory network) is used for the test suite; the three below
// are where this actually deploys. No contract has been deployed to any of
// them yet — see asc-contracts/README.md.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR: settlement-router/TaskEscrow.sol hits "stack too deep" without
      // it (many calldata params + loops). evmVersion: "cancun" because
      // OpenZeppelin's Bytes.sol (pulled in via SafeERC20) uses MCOPY, which
      // only exists from Cancun onward — Base has been on Cancun since
      // March 2024, so this is safe for the real deploy targets too.
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      accounts,
      chainId: 11155111,
    },
    baseSepolia: {
      // `||` not `??`: GitHub Actions injects an unset secret referenced in a
      // workflow's `env:` block as an empty string, not `undefined` — `??`
      // would never fall through to the default in that case.
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts,
      chainId: 84532,
    },
    base: {
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      accounts,
      chainId: 8453,
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY ?? "",
      baseSepolia: process.env.BASESCAN_API_KEY ?? "",
      sepolia: process.env.ETHERSCAN_API_KEY ?? "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: { apiURL: "https://api.basescan.org/api", browserURL: "https://basescan.org" },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: { apiURL: "https://api-sepolia.basescan.org/api", browserURL: "https://sepolia.basescan.org" },
      },
    ],
  },
};

export default config;
