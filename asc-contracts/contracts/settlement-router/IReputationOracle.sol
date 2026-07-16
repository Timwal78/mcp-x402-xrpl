// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IReputationOracle
 * @notice Read interface SettlementRouter uses to size agent performance
 * bonds. The concrete implementation (ReputationOracle.sol) mirrors the
 * ARGUS Agent Credit Bureau score that already lives in this package
 * (src/credit-bureau.ts, 300-850 FICO-style scale) — the same score the
 * 402Proof-branded `proof_credit_score` MCP tool serves today. This is not a
 * second, invented scoring system.
 */
interface IReputationOracle {
    /// @notice Current ARGUS bureau score for `agent` (300-850). Agents never
    /// seen by the oracle read as 300 (PROTOSTAR), matching ARGUS's
    /// "every DID registered at 300 on first contact" rule.
    function getScore(address agent) external view returns (uint256);

    /// @notice Bond requirement for `agent`, in basis points of that agent's
    /// expected payout on a task (10000 = 100%, full prepay).
    function getBondRequirementBps(address agent) external view returns (uint256);
}
