// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { FeeRegistry } from "./FeeRegistry.sol";
import { IReputationOracle } from "./IReputationOracle.sol";
import { TaskEscrow } from "./TaskEscrow.sol";

/**
 * @title SettlementRouter
 * @notice One router per orchestrator, created via SettlementRouterFactory.
 * Deploys a TaskEscrow clone per task and is the only account authorized to
 * call settle()/slash() on that clone. Every constructor argument is
 * immutable — there is no owner, no upgrade path, and no way for this
 * contract to reach into a task's funds except through the orchestrator's
 * own signed calls.
 */
contract SettlementRouter {
    address public immutable factory;
    address public immutable token;
    address public immutable feeRegistry;
    address public immutable reputationOracle;
    address public immutable orchestrator;
    address public immutable escrowImplementation;

    mapping(bytes32 => address) public taskEscrow;

    event TaskCreated(bytes32 indexed taskId, address indexed escrow, uint256 totalPayout, uint256 deadline);
    event TaskSettled(bytes32 indexed taskId, address indexed escrow, uint256 totalFlow, uint256 protocolFee);
    event TaskSlashed(bytes32 indexed taskId, address indexed agent, uint256 amount, address recipient);

    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "SettlementRouter: not orchestrator");
        _;
    }

    constructor(
        address _factory,
        address _token,
        address _feeRegistry,
        address _reputationOracle,
        address _orchestrator,
        address _escrowImplementation
    ) {
        require(_factory != address(0), "SettlementRouter: invalid factory");
        require(_token != address(0), "SettlementRouter: invalid token");
        require(_feeRegistry != address(0), "SettlementRouter: invalid fee registry");
        require(_reputationOracle != address(0), "SettlementRouter: invalid oracle");
        require(_orchestrator != address(0), "SettlementRouter: invalid orchestrator");
        require(_escrowImplementation != address(0), "SettlementRouter: invalid escrow impl");

        factory = _factory;
        token = _token;
        feeRegistry = _feeRegistry;
        reputationOracle = _reputationOracle;
        orchestrator = _orchestrator;
        escrowImplementation = _escrowImplementation;
    }

    /**
     * @notice Deploys a new TaskEscrow clone and registers its participants.
     * Bond requirements are read live from the reputation oracle; a caller
     * supplied override in `bondOverridesBps[i]` can only raise an agent's
     * bond above the oracle's floor, never waive it below — a low-reputation
     * agent can never be under-bonded by an orchestrator's own input.
     */
    function createTask(
        bytes32 taskId,
        address[] calldata agents,
        uint256[] calldata expectedPayouts,
        uint256[] calldata bondOverridesBps,
        uint256 deadline
    ) external onlyOrchestrator returns (address escrow) {
        require(taskEscrow[taskId] == address(0), "SettlementRouter: task exists");
        require(
            agents.length == expectedPayouts.length && agents.length == bondOverridesBps.length,
            "SettlementRouter: length mismatch"
        );
        require(agents.length > 0, "SettlementRouter: no participants");
        require(deadline > block.timestamp, "SettlementRouter: deadline in past");

        uint256[] memory bondsBps = new uint256[](agents.length);
        for (uint256 i = 0; i < agents.length; i++) {
            uint256 floorBps = IReputationOracle(reputationOracle).getBondRequirementBps(agents[i]);
            bondsBps[i] = bondOverridesBps[i] > floorBps ? bondOverridesBps[i] : floorBps;
        }

        escrow = Clones.clone(escrowImplementation);
        TaskEscrow(escrow).initialize(
            address(this),
            token,
            orchestrator,
            taskId,
            deadline,
            agents,
            expectedPayouts,
            bondsBps
        );

        taskEscrow[taskId] = escrow;
        emit TaskCreated(taskId, escrow, TaskEscrow(escrow).taskBudget(), deadline);
    }

    /**
     * @notice Submits the off-chain netting result on-chain. The off-chain
     * TaskGraphValidator is expected to have already checked
     * sum(netPayouts) + protocolFee <= task budget; TaskEscrow.settle()
     * re-checks it independently so an on-chain revert — not a silent
     * shortfall — is the failure mode if that check was skipped or wrong.
     */
    function settleTask(bytes32 taskId, address[] calldata agents, uint256[] calldata netPayouts)
        external
        onlyOrchestrator
    {
        address escrow = taskEscrow[taskId];
        require(escrow != address(0), "SettlementRouter: unknown task");
        require(agents.length == netPayouts.length, "SettlementRouter: length mismatch");

        uint256 totalFlow = 0;
        for (uint256 i = 0; i < netPayouts.length; i++) {
            totalFlow += netPayouts[i];
        }

        uint256 feeBps = FeeRegistry(feeRegistry).protocolFeeBps();
        uint256 protocolFee = (totalFlow * feeBps) / 10000;
        address treasury = FeeRegistry(feeRegistry).treasury();

        TaskEscrow(escrow).settle(agents, netPayouts, protocolFee, treasury);

        emit TaskSettled(taskId, escrow, totalFlow, protocolFee);
    }

    /// @notice MVP slashing path: an orchestrator-vote-driven call (see PRD
    /// "Slashing Oracle" — manual orchestrator vote today, automated output
    /// hash comparison / ARGUS score decay are noted future work, not built).
    function slashAgent(bytes32 taskId, address agent, uint256 amount, address recipient) external onlyOrchestrator {
        address escrow = taskEscrow[taskId];
        require(escrow != address(0), "SettlementRouter: unknown task");

        TaskEscrow(escrow).slash(agent, amount, recipient);
        emit TaskSlashed(taskId, agent, amount, recipient);
    }
}
