// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FeeRegistry
 * @notice The only mutable piece of the x402 Settlement Router. Holds the
 * protocol fee (basis points, hard-capped at 5%) and the treasury address
 * that fee is sent to. `owner` is expected to be a Gnosis Safe multisig, not
 * an EOA — see asc-contracts/README.md for the deployment checklist.
 * @dev Deliberately has no other admin powers: no pause, no blacklist, no
 * ability to touch a TaskEscrow's funds. Settlement Router / Payment Graph
 * Optimizer terminology only — see PRD non-negotiables for banned terms.
 */
contract FeeRegistry {
    uint256 public constant MAX_FEE_BPS = 500; // hard cap: 5%, no governance path can exceed this

    uint256 public protocolFeeBps;
    address public treasury;
    address public owner;

    event ProtocolFeeUpdated(uint256 oldBps, uint256 newBps);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OwnerUpdated(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "FeeRegistry: not owner");
        _;
    }

    constructor(address _owner, address _treasury, uint256 _protocolFeeBps) {
        require(_owner != address(0), "FeeRegistry: invalid owner");
        require(_treasury != address(0), "FeeRegistry: invalid treasury");
        require(_protocolFeeBps <= MAX_FEE_BPS, "FeeRegistry: fee exceeds cap");

        owner = _owner;
        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;

        emit OwnerUpdated(address(0), _owner);
        emit TreasuryUpdated(address(0), _treasury);
        emit ProtocolFeeUpdated(0, _protocolFeeBps);
    }

    function setProtocolFee(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "FeeRegistry: fee exceeds cap");
        emit ProtocolFeeUpdated(protocolFeeBps, newBps);
        protocolFeeBps = newBps;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "FeeRegistry: invalid treasury");
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FeeRegistry: invalid owner");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}
