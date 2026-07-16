// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IReputationOracle } from "./IReputationOracle.sol";

/**
 * @title ReputationOracle
 * @notice On-chain mirror of the ARGUS Agent Credit Bureau score
 * (src/credit-bureau.ts) — the same 300-850 score already exposed off-chain
 * by the `proof_credit_score` MCP tool and the free `GET /api/credit-score`
 * endpoint. Scores are computed off-chain (Redis-backed call history) and
 * pushed here by an authorized `updater` address; this contract does not run
 * its own scoring logic, it only stores and tiers what ARGUS reports.
 * @dev Bond tiers mirror ARGUS's existing tier boundaries exactly
 * (PROTOSTAR/NEUTRON/PULSAR/QUASAR) rather than inventing a parallel scale.
 */
contract ReputationOracle is IReputationOracle {
    uint256 public constant SCORE_MIN = 300;
    uint256 public constant SCORE_MAX = 850;
    uint256 public constant SCORE_DEFAULT = 300; // ARGUS: unseen agent == PROTOSTAR

    uint256 public constant TIER_NEUTRON_MIN = 500;
    uint256 public constant TIER_PULSAR_MIN = 700;
    uint256 public constant TIER_QUASAR_MIN = 800;

    uint256 public constant BOND_PROTOSTAR_BPS = 10000; // 100% — full prepay
    uint256 public constant BOND_NEUTRON_BPS = 5000; // 50%
    uint256 public constant BOND_PULSAR_BPS = 2500; // 25%
    uint256 public constant BOND_QUASAR_BPS = 1000; // 10%

    address public owner;
    address public updater;

    mapping(address => uint256) private _scores;
    mapping(address => bool) private _hasScore;

    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event UpdaterUpdated(address indexed oldUpdater, address indexed newUpdater);
    event ScoreReported(address indexed agent, uint256 score);

    modifier onlyOwner() {
        require(msg.sender == owner, "ReputationOracle: not owner");
        _;
    }

    modifier onlyUpdater() {
        require(msg.sender == updater, "ReputationOracle: not updater");
        _;
    }

    constructor(address _owner, address _updater) {
        require(_owner != address(0), "ReputationOracle: invalid owner");
        require(_updater != address(0), "ReputationOracle: invalid updater");
        owner = _owner;
        updater = _updater;
        emit OwnerUpdated(address(0), _owner);
        emit UpdaterUpdated(address(0), _updater);
    }

    /// @notice Pushes a fresh ARGUS score for one agent. Called by the
    /// off-chain updater (scripts/update-reputation-oracle.ts) after reading
    /// the real score from the live credit-bureau endpoint.
    function reportScore(address agent, uint256 score) external onlyUpdater {
        _setScore(agent, score);
    }

    function reportScores(address[] calldata agents, uint256[] calldata scores) external onlyUpdater {
        require(agents.length == scores.length, "ReputationOracle: length mismatch");
        for (uint256 i = 0; i < agents.length; i++) {
            _setScore(agents[i], scores[i]);
        }
    }

    function _setScore(address agent, uint256 score) internal {
        require(agent != address(0), "ReputationOracle: invalid agent");
        require(score >= SCORE_MIN && score <= SCORE_MAX, "ReputationOracle: score out of range");
        _scores[agent] = score;
        _hasScore[agent] = true;
        emit ScoreReported(agent, score);
    }

    function getScore(address agent) public view override returns (uint256) {
        return _hasScore[agent] ? _scores[agent] : SCORE_DEFAULT;
    }

    function getBondRequirementBps(address agent) external view override returns (uint256) {
        uint256 score = getScore(agent);
        if (score >= TIER_QUASAR_MIN) return BOND_QUASAR_BPS;
        if (score >= TIER_PULSAR_MIN) return BOND_PULSAR_BPS;
        if (score >= TIER_NEUTRON_MIN) return BOND_NEUTRON_BPS;
        return BOND_PROTOSTAR_BPS;
    }

    function setUpdater(address newUpdater) external onlyOwner {
        require(newUpdater != address(0), "ReputationOracle: invalid updater");
        emit UpdaterUpdated(updater, newUpdater);
        updater = newUpdater;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ReputationOracle: invalid owner");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}
