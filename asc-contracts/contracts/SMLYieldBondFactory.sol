// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SMLYieldBond.sol";

/**
 * @title SMLYieldBondFactory
 * @notice Factory contract to deploy and index SMLYieldBond instances securely.
 */
contract SMLYieldBondFactory {
    address public immutable protocolTreasury;
    uint256 public constant protocolFeeBasisPoints = 50; // 0.5% standard fee
    address[] public deployedBonds;

    event BondDeployed(
        address indexed bondAddress,
        address indexed operator,
        address indexed paymentToken,
        uint256 fundingTarget
    );

    constructor(address _protocolTreasury) {
        require(_protocolTreasury != address(0), "SMLFactory: Invalid treasury address");
        protocolTreasury = _protocolTreasury;
    }

    /**
     * @notice Deploys a new SMLYieldBond instance.
     */
    function deployBond(
        address _paymentToken,
        uint256 _fundingTarget,
        uint256 _repaymentCapMultiplier,
        uint256 _repaymentSplitBasisPoints
    ) external returns (address) {
        require(_fundingTarget > 0, "SMLFactory: Invalid target");
        require(_repaymentCapMultiplier > 10000, "SMLFactory: Multiplier must be > 100%");
        require(_repaymentSplitBasisPoints > 0 && _repaymentSplitBasisPoints < 10000, "SMLFactory: Invalid split");

        SMLYieldBond newBond = new SMLYieldBond(
            msg.sender,
            _paymentToken,
            protocolTreasury,
            _fundingTarget,
            _repaymentCapMultiplier,
            _repaymentSplitBasisPoints,
            protocolFeeBasisPoints
        );

        deployedBonds.push(address(newBond));
        emit BondDeployed(address(newBond), msg.sender, _paymentToken, _fundingTarget);

        return address(newBond);
    }

    /**
     * @notice Returns all deployed bonds.
     */
    function getDeployedBonds() external view returns (address[] memory) {
        return deployedBonds;
    }
}
