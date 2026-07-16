// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @title TaskEscrow
 * @notice One escrow per task, deployed as an ERC-1167 minimal proxy clone
 * by SettlementRouter.createTask(). Holds the task budget (funded by the
 * orchestrator) and every agent's performance bond until settlement, slash,
 * cancellation, or emergency withdrawal.
 * @dev IMMUTABLE-BY-CONVENTION: this contract has no admin key, no upgrade
 * path, no pause, and no blacklist. State is set exactly once in
 * `initialize()` (via `initializer`, from OpenZeppelin's Initializable) and
 * every other function only ever moves funds out, never re-configures the
 * escrow. Note: `immutable` Solidity keywords cannot be used here — EIP-1167
 * clones delegatecall into this contract's own deployed bytecode, so any
 * `immutable` value would read back the *implementation* contract's
 * constructor-time value (which never runs meaningfully, see constructor
 * below), not a value scoped to the calling clone. Regular storage set in
 * `initialize()` is correct for clones; `immutable` is not.
 */
contract TaskEscrow is Initializable {
    using SafeERC20 for IERC20;

    uint256 public constant EMERGENCY_TIMELOCK = 7 days;

    address public router;
    IERC20 public token;
    address public orchestrator;
    bytes32 public taskId;
    uint256 public deadline;
    uint256 public createdAt;

    uint256 public taskBudget;
    uint256 public totalBonded;
    bool public isSettled;
    bool public isCancelled;

    address[] public agentList;
    mapping(address => bool) public isParticipant;
    mapping(address => uint256) public expectedPayout;
    mapping(address => uint256) public bondRequired;
    mapping(address => uint256) public bondDeposited;
    mapping(address => bool) private _settledFlag;

    event TaskInitialized(bytes32 indexed taskId, address indexed orchestrator, uint256 deadline, uint256 taskBudget);
    event TaskBudgetDeposited(address indexed from, uint256 amount);
    event BondDeposited(address indexed agent, uint256 amount);
    event Settled(uint256 totalFlow, uint256 protocolFee, uint256 remainderToOrchestrator);
    event Slashed(address indexed agent, uint256 amount, address indexed recipient);
    event Cancelled(uint256 budgetRefundedToOrchestrator, uint256 bondsRefunded);
    event EmergencyWithdraw(address indexed orchestrator, uint256 amount);

    modifier onlyRouter() {
        require(msg.sender == router, "TaskEscrow: not router");
        _;
    }

    modifier onlyOrchestrator() {
        require(msg.sender == orchestrator, "TaskEscrow: not orchestrator");
        _;
    }

    modifier notClosed() {
        require(!isSettled && !isCancelled, "TaskEscrow: task closed");
        _;
    }

    /// @dev Disables initializers on the implementation contract itself, so
    /// nobody can call initialize() directly on the template TaskEscrow that
    /// SettlementRouterFactory deploys and every clone points at.
    constructor() {
        _disableInitializers();
    }

    /// @notice Called exactly once by SettlementRouter immediately after
    /// cloning. `expectedPayouts` sums to `taskBudget` — the amount the
    /// orchestrator is expected to fund via depositTaskBudget().
    function initialize(
        address _router,
        address _token,
        address _orchestrator,
        bytes32 _taskId,
        uint256 _deadline,
        address[] calldata agents,
        uint256[] calldata expectedPayouts,
        uint256[] calldata bondsBps
    ) external initializer {
        require(_router != address(0), "TaskEscrow: invalid router");
        require(_token != address(0), "TaskEscrow: invalid token");
        require(_orchestrator != address(0), "TaskEscrow: invalid orchestrator");
        require(
            agents.length == expectedPayouts.length && agents.length == bondsBps.length,
            "TaskEscrow: length mismatch"
        );
        require(agents.length > 0, "TaskEscrow: no participants");

        router = _router;
        token = IERC20(_token);
        orchestrator = _orchestrator;
        taskId = _taskId;
        deadline = _deadline;
        createdAt = block.timestamp;

        uint256 budget = 0;
        for (uint256 i = 0; i < agents.length; i++) {
            address agent = agents[i];
            require(agent != address(0), "TaskEscrow: invalid agent");
            require(!isParticipant[agent], "TaskEscrow: duplicate agent");

            isParticipant[agent] = true;
            agentList.push(agent);
            expectedPayout[agent] = expectedPayouts[i];
            bondRequired[agent] = (expectedPayouts[i] * bondsBps[i]) / 10000;
            budget += expectedPayouts[i];
        }
        taskBudget = budget;

        emit TaskInitialized(_taskId, _orchestrator, _deadline, budget);
    }

    /// @notice Orchestrator (or anyone funding on the orchestrator's behalf)
    /// deposits the task budget. Can be called in multiple installments.
    function depositTaskBudget(uint256 amount) external notClosed {
        require(amount > 0, "TaskEscrow: zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit TaskBudgetDeposited(msg.sender, amount);
    }

    /// @notice Posts performance bond on behalf of `agent`. Callable by
    /// anyone (the agent itself, or a sponsor) — `agent` need not be
    /// msg.sender, only an already-registered task participant.
    function depositBond(address agent, uint256 amount) external notClosed {
        _recordBond(agent, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Gasless-approval variant — no separate approve() transaction.
    function depositBondWithPermit(
        address agent,
        uint256 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external notClosed {
        _recordBond(agent, amount);
        IERC20Permit(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function _recordBond(address agent, uint256 amount) internal {
        require(isParticipant[agent], "TaskEscrow: unknown agent");
        require(amount > 0, "TaskEscrow: zero amount");
        bondDeposited[agent] += amount;
        totalBonded += amount;
        emit BondDeposited(agent, amount);
    }

    /// @notice Router-only. Distributes the off-chain-computed net payouts,
    /// sends the protocol fee to `treasury`, returns every posted bond in
    /// full to its depositor, and refunds any leftover task budget to the
    /// orchestrator. Reverts if the caller-supplied payouts + fee would
    /// exceed the funded task budget — this is the on-chain half of the
    /// off-chain TaskGraphValidator's pre-flight check.
    function settle(
        address[] calldata agents,
        uint256[] calldata netPayouts,
        uint256 protocolFee,
        address treasury
    ) external onlyRouter notClosed {
        require(agents.length == netPayouts.length, "TaskEscrow: length mismatch");

        isSettled = true;

        uint256 totalOut = protocolFee;
        for (uint256 i = 0; i < agents.length; i++) {
            require(isParticipant[agents[i]], "TaskEscrow: unknown agent");
            require(!_settledFlag[agents[i]], "TaskEscrow: duplicate settle entry");
            _settledFlag[agents[i]] = true;
            totalOut += netPayouts[i];
        }
        require(totalOut <= taskBudget, "TaskEscrow: payouts exceed budget");
        require(token.balanceOf(address(this)) >= totalOut + totalBonded, "TaskEscrow: underfunded");

        for (uint256 i = 0; i < agents.length; i++) {
            if (netPayouts[i] > 0) {
                token.safeTransfer(agents[i], netPayouts[i]);
            }
        }

        if (protocolFee > 0) {
            token.safeTransfer(treasury, protocolFee);
        }

        // Bonds are performance collateral, never a source of settlement
        // revenue — every agent gets their full bond back regardless of
        // whether they earned a net payout this round.
        for (uint256 i = 0; i < agentList.length; i++) {
            address agent = agentList[i];
            uint256 bond = bondDeposited[agent];
            if (bond > 0) {
                bondDeposited[agent] = 0;
                token.safeTransfer(agent, bond);
            }
        }
        totalBonded = 0;

        uint256 remainder = taskBudget - totalOut;
        if (remainder > 0) {
            token.safeTransfer(orchestrator, remainder);
        }

        emit Settled(totalOut, protocolFee, remainder);
    }

    /// @notice Router-only slashing path (MVP: orchestrator vote surfaced
    /// through SettlementRouter.slashAgent). Moves up to the agent's posted
    /// bond to `recipient` — never more than what that agent deposited.
    function slash(address agent, uint256 amount, address recipient) external onlyRouter notClosed {
        require(isParticipant[agent], "TaskEscrow: unknown agent");
        require(amount > 0 && amount <= bondDeposited[agent], "TaskEscrow: invalid slash amount");
        require(recipient != address(0), "TaskEscrow: invalid recipient");

        bondDeposited[agent] -= amount;
        totalBonded -= amount;
        token.safeTransfer(recipient, amount);

        emit Slashed(agent, amount, recipient);
    }

    /// @notice Orchestrator-only, any time before settlement. Returns every
    /// posted bond to its depositor and the remaining task budget to the
    /// orchestrator.
    function cancel() external onlyOrchestrator notClosed {
        isCancelled = true;

        uint256 totalBalance = token.balanceOf(address(this));
        uint256 bondsRefund = 0;

        for (uint256 i = 0; i < agentList.length; i++) {
            address agent = agentList[i];
            uint256 bond = bondDeposited[agent];
            if (bond > 0) {
                bondDeposited[agent] = 0;
                bondsRefund += bond;
                token.safeTransfer(agent, bond);
            }
        }
        totalBonded = 0;

        uint256 budgetRefund = totalBalance - bondsRefund;
        if (budgetRefund > 0) {
            token.safeTransfer(orchestrator, budgetRefund);
        }

        emit Cancelled(budgetRefund, bondsRefund);
    }

    /// @notice Orchestrator-only rescue hatch if the router is compromised
    /// or simply never calls settle(). Only usable 7 days past the task's
    /// own deadline, and only if the task was never actually settled.
    function emergencyWithdraw() external onlyOrchestrator {
        require(!isSettled, "TaskEscrow: already settled");
        require(!isCancelled, "TaskEscrow: already cancelled");
        require(block.timestamp >= deadline + EMERGENCY_TIMELOCK, "TaskEscrow: timelock active");

        isCancelled = true;
        totalBonded = 0;

        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            token.safeTransfer(orchestrator, balance);
        }

        emit EmergencyWithdraw(orchestrator, balance);
    }

    function getAgents() external view returns (address[] memory) {
        return agentList;
    }
}
