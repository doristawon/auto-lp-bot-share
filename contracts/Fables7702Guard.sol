// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface IFablesWithdrawHook {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function withdrawAndClaim(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address recipient,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline,
        uint16 walk
    ) external;
}

/// @notice EIP-7702 delegation target for atomic Fables OOR withdrawal.
/// @dev This code is intended to execute at the EOA address through EIP-7702.
///      Direct calls to the implementation cannot withdraw user positions.
contract Fables7702Guard {
    // Public so setup/verification tooling can prove that delegated runtime code
    // is the exact implementation address that was configured and audited.
    // The immutable value is baked into the implementation bytecode at deploy time.
    address public immutable IMPLEMENTATION = address(this);
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    error DirectImplementationCall();
    error OnlySelfCall();
    error WrongChain(uint256 chainId);
    error InRange(int24 currentTick, int24 tickLower, int24 tickUpper);
    error InvalidRecipient(address recipient);
    error InvalidHook(address hook);
    error ZeroLiquidity();

    receive() external payable {}
    fallback() external payable {}

    function guardVersion() external pure returns (bytes32) {
        return keccak256("Fables7702Guard/v1");
    }

    function guardedWithdrawAndClaim(
        IFablesWithdrawHook.PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        address recipient,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline,
        uint16 walk
    ) external {
        if (address(this) == IMPLEMENTATION) revert DirectImplementationCall();
        if (msg.sender != address(this)) revert OnlySelfCall();
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        if (key.hooks == address(0)) revert InvalidHook(key.hooks);
        if (liquidity == 0) revert ZeroLiquidity();
        if (recipient != address(this)) revert InvalidRecipient(recipient);

        bytes32 poolId = keccak256(abi.encode(key));
        (, int24 currentTick,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        if (currentTick >= tickLower && currentTick < tickUpper) {
            revert InRange(currentTick, tickLower, tickUpper);
        }

        IFablesWithdrawHook(key.hooks).withdrawAndClaim(
            key,
            tickLower,
            tickUpper,
            liquidity,
            recipient,
            amount0Min,
            amount1Min,
            deadline,
            walk
        );
    }
}
