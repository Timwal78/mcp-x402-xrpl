// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FeeRegistry } from "./FeeRegistry.sol";
import { ReputationOracle } from "./ReputationOracle.sol";
import { SettlementRouter } from "./SettlementRouter.sol";
import { TaskEscrow } from "./TaskEscrow.sol";

/**
 * @title SettlementRouterFactory
 * @notice Singleton, deployed once by ScriptMasterLabs. Deploys the shared
 * FeeRegistry, ReputationOracle, and TaskEscrow clone template, then hands
 * out exactly one SettlementRouter per orchestrator address on request.
 */
contract SettlementRouterFactory {
    address public immutable token;
    address public immutable feeRegistry;
    address public immutable reputationOracle;
    address public immutable escrowImplementation;

    mapping(address => address) public orchestratorToRouter;
    address[] public deployedRouters;

    event RouterCreated(address indexed orchestrator, address indexed router);

    /// @param _token Settlement token (USDC on Base for V1).
    /// @param _treasury FeeRegistry treasury — must be a multisig, not an EOA.
    /// @param _protocolFeeBps Initial protocol fee, basis points (50 = 0.5%).
    /// @param _reputationUpdater Address authorized to push ARGUS scores
    /// into ReputationOracle (the off-chain updater service's signer).
    constructor(address _token, address _treasury, uint256 _protocolFeeBps, address _reputationUpdater) {
        require(_token != address(0), "SettlementRouterFactory: invalid token");

        token = _token;
        feeRegistry = address(new FeeRegistry(msg.sender, _treasury, _protocolFeeBps));
        reputationOracle = address(new ReputationOracle(msg.sender, _reputationUpdater));
        escrowImplementation = address(new TaskEscrow());
    }

    function createRouter(address orchestrator) external returns (address router) {
        require(orchestrator != address(0), "SettlementRouterFactory: invalid orchestrator");
        require(orchestratorToRouter[orchestrator] == address(0), "SettlementRouterFactory: router exists");

        router = address(
            new SettlementRouter(address(this), token, feeRegistry, reputationOracle, orchestrator, escrowImplementation)
        );

        orchestratorToRouter[orchestrator] = router;
        deployedRouters.push(router);

        emit RouterCreated(orchestrator, router);
    }

    function getDeployedRouters() external view returns (address[] memory) {
        return deployedRouters;
    }
}
