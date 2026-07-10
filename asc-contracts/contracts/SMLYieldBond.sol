// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 */
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/**
 * @title SMLYieldBond
 * @notice Programmatic revenue-factoring contract for SML Autonomous Software Corporations.
 * @dev Non-custodial: this contract only ever holds funds mid-transaction (fund() -> _closeFunding(),
 * processRevenue() -> payout loop). It never retains a balance between calls by design.
 *
 * COMPLIANCE FRAMING (see INSTRUMENT_TYPE below) — this is deal terms encoded as code, not a
 * legal opinion. Confirm the structure with securities counsel in your jurisdiction before any
 * real investor deposits funds:
 *  - Capped revenue-factoring / royalty agreement. Investors get no shares, no voting rights, and
 *    no ownership interest in the operator's business, IP, or this contract's admin keys (it has none).
 *  - Return is hard-capped at `repaymentCapMultiplier` (e.g. 11500 = 115% of principal). Once
 *    `amountRepaid[investor] == maxRepayment`, that investor is paid nothing further by processRevenue().
 *  - Each bond is a single, isolated agreement between its investors and its operator — this contract
 *    does not pool capital across bonds or make investment decisions on anyone's behalf.
 *  - Fully autonomous once deployed and funded: fund()/processRevenue() compute and route every split
 *    without any human judgment call. The protocol operator (protocolTreasury) never touches investor
 *    principal or the operator's revenue share — it only ever receives `protocolFeeBasisPoints` (set by
 *    the factory, 0.5% here), paid automatically at funding close, identically on every bond.
 */
contract SMLYieldBond is ReentrancyGuard {
    /// @notice Machine- and human-readable instrument description, set once at deploy time so it's
    /// visible to any block explorer or off-chain due-diligence tool without reading this source file.
    /// This is disclosure, not a legal opinion — see the contract-level NatSpec above.
    string public constant INSTRUMENT_TYPE =
        "Capped revenue-factoring / royalty agreement. NOT equity. NOT a pooled investment fund. "
        "No voting rights. No ownership interest. Return capped at repaymentCapMultiplier. "
        "Non-custodial, autonomous execution - operator/protocol never hold funds between calls. "
        "Not legal advice; consult securities counsel in your jurisdiction before investing.";

    address public immutable factory;
    address public immutable operator;
    address public immutable paymentToken;
    address public immutable protocolTreasury;

    uint256 public immutable fundingTarget;
    uint256 public immutable repaymentCapMultiplier; // Basis points (e.g., 11500 for 115%)
    uint256 public immutable repaymentSplitBasisPoints; // Basis points of revenue sent to investors (e.g., 1500 for 15%)
    uint256 public immutable protocolFeeBasisPoints; // Factory fee on initial raise (e.g., 50 for 0.5%)

    uint256 public totalRaised;
    uint256 public totalRepaid;
    bool public isFundingClosed;

    address[] public investors;
    mapping(address => uint256) public investmentAmount;
    mapping(address => uint256) public amountRepaid;

    event Funded(address indexed investor, uint256 amount);
    event FundingClosed(uint256 totalRaised);
    event RevenueProcessed(uint256 totalAmount, uint256 investorShare, uint256 operatorShare);
    event RepaymentCompleted(address indexed investor, uint256 totalPayout);

    constructor(
        address _operator,
        address _paymentToken,
        address _protocolTreasury,
        uint256 _fundingTarget,
        uint256 _repaymentCapMultiplier,
        uint256 _repaymentSplitBasisPoints,
        uint256 _protocolFeeBasisPoints
    ) {
        factory = msg.sender;
        operator = _operator;
        paymentToken = _paymentToken;
        protocolTreasury = _protocolTreasury;
        fundingTarget = _fundingTarget;
        repaymentCapMultiplier = _repaymentCapMultiplier;
        repaymentSplitBasisPoints = _repaymentSplitBasisPoints;
        protocolFeeBasisPoints = _protocolFeeBasisPoints;
    }

    /**
     * @notice Allows an investor to fund the ASC operational treasury.
     * @param amount The amount of payment token (USDC/RLUSD) to invest.
     */
    function fund(uint256 amount) external nonReentrant {
        require(!isFundingClosed, "SMLBond: Funding period closed");
        require(totalRaised + amount <= fundingTarget, "SMLBond: Target exceeded");
        require(amount > 0, "SMLBond: Amount must be greater than zero");

        IERC20 token = IERC20(paymentToken);
        require(token.transferFrom(msg.sender, address(this), amount), "SMLBond: Token transfer failed");

        if (investmentAmount[msg.sender] == 0) {
            investors.push(msg.sender);
        }

        investmentAmount[msg.sender] += amount;
        totalRaised += amount;

        emit Funded(msg.sender, amount);

        if (totalRaised == fundingTarget) {
            _closeFunding();
        }
    }

    /**
     * @notice Internal function to execute funding close-out, routing protocol fees and working capital.
     */
    function _closeFunding() internal {
        isFundingClosed = true;
        IERC20 token = IERC20(paymentToken);

        uint256 protocolFee = (totalRaised * protocolFeeBasisPoints) / 10000;
        uint256 operationalCapital = totalRaised - protocolFee;

        require(token.transfer(protocolTreasury, protocolFee), "SMLBond: Protocol fee transfer failed");
        require(token.transfer(operator, operationalCapital), "SMLBond: Operational transfer failed");

        emit FundingClosed(totalRaised);
    }

    /**
     * @notice Processes incoming x402 revenue payments, programmatically splitting funds between investors and operator.
     * @param revenueAmount Total incoming revenue from tool executions.
     */
    function processRevenue(uint256 revenueAmount) external nonReentrant {
        require(msg.sender == operator, "SMLBond: Only operator can route revenue");
        require(isFundingClosed, "SMLBond: Operational period not active");

        IERC20 token = IERC20(paymentToken);
        require(token.transferFrom(msg.sender, address(this), revenueAmount), "SMLBond: Revenue transfer failed");

        uint256 investorSplitTotal = (revenueAmount * repaymentSplitBasisPoints) / 10000;
        uint256 distributedInvestorShare = 0;

        for (uint256 i = 0; i < investors.length; i++) {
            address investor = investors[i];
            uint256 maxRepayment = (investmentAmount[investor] * repaymentCapMultiplier) / 10000;

            if (amountRepaid[investor] < maxRepayment) {
                uint256 investorProRataShare = (investorSplitTotal * investmentAmount[investor]) / totalRaised;
                uint256 remainingDue = maxRepayment - amountRepaid[investor];
                uint256 payout = investorProRataShare > remainingDue ? remainingDue : investorProRataShare;

                if (payout > 0) {
                    amountRepaid[investor] += payout;
                    totalRepaid += payout;
                    distributedInvestorShare += payout;
                    require(token.transfer(investor, payout), "SMLBond: Payout failed");

                    if (amountRepaid[investor] == maxRepayment) {
                        emit RepaymentCompleted(investor, maxRepayment);
                    }
                }
            }
        }

        uint256 operatorShare = revenueAmount - distributedInvestorShare;
        require(token.transfer(operator, operatorShare), "SMLBond: Operator payout failed");

        emit RevenueProcessed(revenueAmount, distributedInvestorShare, operatorShare);
    }

    /**
     * @notice Returns the list of active investors.
     */
    function getInvestors() external view returns (address[] memory) {
        return investors;
    }
}
