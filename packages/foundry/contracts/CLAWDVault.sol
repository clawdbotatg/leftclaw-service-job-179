// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* -------------------------------------------------------------------------- */
/*                              External Interfaces                            */
/* -------------------------------------------------------------------------- */

interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData)
        external
        returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/* -------------------------------------------------------------------------- */
/*                                  TickMath                                   */
/* -------------------------------------------------------------------------- */
/// @notice Subset of Uniswap V3 TickMath - exposes getSqrtRatioAtTick.
/// @dev Verbatim port of the canonical Uniswap V3 implementation, made 0.8.x-safe with unchecked blocks.
library TickMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = -MIN_TICK;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), "T");

            uint256 ratio =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // shift from Q128.128 to Q128.96, rounding up
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                                 CLAWD Vault                                 */
/* -------------------------------------------------------------------------- */

/// @title CLAWD Accumulator Vault
/// @notice Personal single-owner vault that buys CLAWD on dips and sells on pumps
///         relative to a Uniswap V3 TWAP. Trades are triggered by Chainlink Automation.
/// @dev    Targets the CLAWD/USDC 1% pool on Base. token0 = USDC (6 dec), token1 = CLAWD (18 dec).
contract CLAWDVault is Ownable2Step, ReentrancyGuard, AutomationCompatibleInterface {
    using SafeERC20 for IERC20;

    /* --------------------------- Immutable wiring --------------------------- */

    /// @notice CLAWD ERC20 (Base mainnet)
    address public constant CLAWD = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
    /// @notice USDC ERC20 (Base mainnet)
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    /// @notice CLAWD/USDC Uniswap V3 1% pool (Base mainnet)
    address public constant POOL = 0xb72A6e1091D43e19284050b7132e0646509EBa5d;
    /// @notice Uniswap V3 SwapRouter02 (Base mainnet)
    address public constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    /// @notice Uniswap V3 pool fee (1%)
    uint24 public constant POOL_FEE = 10000;

    /// @notice Hard floor for the TWAP window (seconds). Cannot be lowered.
    uint32 public constant MIN_TWAP_WINDOW = 1800;

    /// @notice Price denomination: USDC units per 1 CLAWD scaled to 1e6.
    ///         Example: 0.05 USDC per CLAWD -> 50_000.
    uint256 public constant PRICE_DECIMALS = 1e6;

    /* ---------------------------- Configurable params ----------------------------- */

    /// @notice Spot must exceed TWAP by this many bps to trigger a sell.
    uint256 public pumpThresholdBps;
    /// @notice Spot must be below TWAP by this many bps to trigger a buy.
    uint256 public dipThresholdBps;
    /// @notice Percentage of CLAWD balance to sell per pump trigger (1-100).
    uint256 public sellPct;
    /// @notice Percentage of USDC balance to deploy per dip trigger (1-100).
    uint256 public buyPct;
    /// @notice TWAP lookback in seconds; enforced >= MIN_TWAP_WINDOW.
    uint32 public twapWindow;
    /// @notice Maximum allowed slippage on swaps in bps (10000 = 100%).
    uint256 public maxSlippageBps;

    /* --------------------------------- Events --------------------------------- */

    event SwapExecuted(
        string direction,
        uint256 amountIn,
        uint256 amountOut,
        uint256 spotPrice,
        uint256 twapPrice,
        uint256 timestamp
    );
    event ParametersUpdated(
        uint256 pumpBps, uint256 dipBps, uint256 sellPct, uint256 buyPct, uint32 twapWindow, uint256 maxSlippageBps
    );
    event Deposited(address token, uint256 amount);
    event Withdrawn(address token, uint256 amount);

    /* --------------------------------- Errors --------------------------------- */

    error UnsupportedToken();
    error InvalidPercent();
    error TwapWindowTooShort();
    error InvalidSlippage();
    error NoUpkeepNeeded();
    error InsufficientPoolHistory();
    error NothingToSwap();
    error InvalidAmount();

    /* ------------------------------- Constructor ------------------------------- */

    constructor(address _owner) Ownable(_owner) {
        // Defaults per spec
        pumpThresholdBps = 500; // +5%
        dipThresholdBps = 500; // -5%
        sellPct = 20;
        buyPct = 20;
        twapWindow = 1800;
        maxSlippageBps = 100; // 1%

        // Floor must hold even on the initial value.
        if (twapWindow < MIN_TWAP_WINDOW) revert TwapWindowTooShort();

        // Ownable's constructor already assigns ownership to `_owner`; we keep an
        // explicit _transferOwnership call so the spec's wording is honored 1:1.
        if (_owner != owner()) {
            _transferOwnership(_owner);
        }
    }

    /* --------------------------------- Admin ---------------------------------- */

    /// @notice Deposit CLAWD or USDC into the vault from the owner.
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token != CLAWD && token != USDC) revert UnsupportedToken();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    /// @notice Withdraw CLAWD or USDC out of the vault to the owner.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token != CLAWD && token != USDC) revert UnsupportedToken();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(token, amount);
    }

    /// @notice Update strategy parameters. All values validated.
    function setParameters(
        uint256 _pumpBps,
        uint256 _dipBps,
        uint256 _sellPct,
        uint256 _buyPct,
        uint32 _twapWindow,
        uint256 _maxSlippageBps
    ) external onlyOwner {
        if (_twapWindow < MIN_TWAP_WINDOW) revert TwapWindowTooShort();
        if (_sellPct == 0 || _sellPct > 100) revert InvalidPercent();
        if (_buyPct == 0 || _buyPct > 100) revert InvalidPercent();
        if (_maxSlippageBps == 0 || _maxSlippageBps > 10000) revert InvalidSlippage();

        pumpThresholdBps = _pumpBps;
        dipThresholdBps = _dipBps;
        sellPct = _sellPct;
        buyPct = _buyPct;
        twapWindow = _twapWindow;
        maxSlippageBps = _maxSlippageBps;

        emit ParametersUpdated(_pumpBps, _dipBps, _sellPct, _buyPct, _twapWindow, _maxSlippageBps);
    }

    /* -------------------------- Chainlink Automation -------------------------- */

    /// @inheritdoc AutomationCompatibleInterface
    /// @dev Marked view-compatible: Chainlink calls this off-chain, but spec requires `view`.
    function checkUpkeep(bytes calldata /* checkData */ )
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        (bool isPump, bool isDip,,) = _evaluate();

        if (isPump && _clawdBalance() > 0) {
            return (true, abi.encode("sell"));
        }
        if (isDip && _usdcBalance() > 0) {
            return (true, abi.encode("buy"));
        }
        return (false, bytes(""));
    }

    /// @inheritdoc AutomationCompatibleInterface
    /// @dev `performData` is informational only; the condition is re-verified here.
    function performUpkeep(bytes calldata /* performData */ ) external override nonReentrant {
        (bool isPump, bool isDip, uint256 spot, uint256 twap) = _evaluate();

        if (isPump) {
            uint256 clawdBal = _clawdBalance();
            if (clawdBal == 0) revert NothingToSwap();
            uint256 amountIn = (clawdBal * sellPct) / 100;
            if (amountIn == 0) revert NothingToSwap();
            uint256 amountOut = _sellCLAWD(amountIn, twap);
            emit SwapExecuted("sell", amountIn, amountOut, spot, twap, block.timestamp);
            return;
        }

        if (isDip) {
            uint256 usdcBal = _usdcBalance();
            if (usdcBal == 0) revert NothingToSwap();
            uint256 amountIn = (usdcBal * buyPct) / 100;
            if (amountIn == 0) revert NothingToSwap();
            uint256 amountOut = _buyCLAWD(amountIn, twap);
            emit SwapExecuted("buy", amountIn, amountOut, spot, twap, block.timestamp);
            return;
        }

        revert NoUpkeepNeeded();
    }

    /* ---------------------------------- Views --------------------------------- */

    /// @notice Time-weighted average price of CLAWD denominated in USDC.
    /// @return clawdPerUsdc USDC units per 1 CLAWD scaled to 1e6 (PRICE_DECIMALS).
    ///         (Returned value is "USDC per CLAWD" - the variable name follows the spec verbatim.)
    function getTWAP() public view returns (uint256 clawdPerUsdc) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;

        int56[] memory tickCumulatives;
        try IUniswapV3Pool(POOL).observe(secondsAgos) returns (
            int56[] memory _tc, uint160[] memory /* _spl */
        ) {
            tickCumulatives = _tc;
        } catch {
            revert InsufficientPoolHistory();
        }

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 avgTick = int24(tickDelta / int56(uint56(twapWindow)));
        // Match Uniswap's OracleLibrary rounding: round toward negative infinity.
        if (tickDelta < 0 && (tickDelta % int56(uint56(twapWindow)) != 0)) {
            avgTick--;
        }

        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(avgTick);
        return _sqrtPriceX96ToUsdcPerClawd(sqrtPriceX96);
    }

    /// @notice Current spot price of CLAWD denominated in USDC (same scaling as TWAP).
    function getSpotPrice() public view returns (uint256 clawdPerUsdc) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(POOL).slot0();
        return _sqrtPriceX96ToUsdcPerClawd(sqrtPriceX96);
    }

    /// @notice Convenience getter for both vault balances.
    function getVaultBalances() external view returns (uint256 clawdBalance, uint256 usdcBalance) {
        return (_clawdBalance(), _usdcBalance());
    }

    /* -------------------------------- Internals ------------------------------- */

    function _clawdBalance() internal view returns (uint256) {
        return IERC20(CLAWD).balanceOf(address(this));
    }

    function _usdcBalance() internal view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    /// @dev Returns trigger flags and the current spot/TWAP prices used to evaluate them.
    function _evaluate() internal view returns (bool isPump, bool isDip, uint256 spot, uint256 twap) {
        spot = getSpotPrice();
        twap = getTWAP();

        // Pump: spot >= twap * (1 + pumpThresholdBps / 10000)
        uint256 pumpTrigger = twap + (twap * pumpThresholdBps) / 10000;
        // Dip:  spot <= twap * (1 - dipThresholdBps / 10000)
        uint256 dipTrigger = twap - (twap * dipThresholdBps) / 10000;

        isPump = spot >= pumpTrigger;
        isDip = spot <= dipTrigger;
    }

    /// @dev Convert a sqrtPriceX96 (token1/token0 in raw units, here CLAWD/USDC)
    ///      to "USDC units per 1 CLAWD" scaled to PRICE_DECIMALS (1e6).
    ///
    ///      Raw price token1/token0 = (sqrtPriceX96)^2 / 2^192
    ///      That ratio is CLAWD raw units per USDC raw unit.
    ///      Decimal-normalised CLAWD per USDC = raw * 10^(6-18) = raw / 1e12
    ///      Invert to USDC per CLAWD (decimal-normalised), then * 1e6 for scaling.
    ///
    ///      Combined: result = (2^192 * 1e6 * 1e12) / sqrtPriceX96^2  (USDC per CLAWD * 1e6)
    ///                       = (2^192 * 1e18) / sqrtPriceX96^2
    function _sqrtPriceX96ToUsdcPerClawd(uint160 sqrtPriceX96) internal pure returns (uint256) {
        // sqrtPriceX96 fits in 160 bits, so its square fits in 320 bits - we need a full
        // 512-bit numerator. Split the math via mulDiv-style staging to avoid overflow:
        // numerator = 2^192 * 1e18, denominator = sqrtPriceX96^2.

        // Compute price_raw_x192 = sqrtPriceX96^2 (up to 320 bits).
        // To divide 2^192 * 1e18 by sqrtPriceX96^2 without overflow, we stage as:
        //   step1 = (2^96 * 1e18) / sqrtPriceX96    -> fits in 256 bits comfortably
        //   step2 = (step1 * 2^96) / sqrtPriceX96   -> final scaled price
        // This preserves precision because each division is by sqrtPriceX96, not its square.
        uint256 sp = uint256(sqrtPriceX96);
        if (sp == 0) return 0;

        // 2^96 = 79228162514264337593543950336
        uint256 Q96 = 0x1000000000000000000000000; // 2^96
        uint256 step1 = (Q96 * 1e18) / sp;
        uint256 step2 = (step1 * Q96) / sp;
        return step2;
    }

    /// @dev Sell CLAWD -> USDC via SwapRouter02 with TWAP-anchored min-out guard.
    function _sellCLAWD(uint256 amountIn, uint256 twapUsdcPerClawd) internal returns (uint256 amountOut) {
        // Expected USDC out = amountIn (CLAWD, 18 dec) * twap (USDC/CLAWD, scaled 1e6) / 1e18 / 1e6 * 1e6
        //                   = amountIn * twap / 1e18  (result already in 6-dec USDC units)
        uint256 expectedOut = (amountIn * twapUsdcPerClawd) / 1e18;
        uint256 minOut = (expectedOut * (10000 - maxSlippageBps)) / 10000;
        require(minOut > 0, "minOut=0");

        IERC20(CLAWD).forceApprove(SWAP_ROUTER, amountIn);

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn: CLAWD,
            tokenOut: USDC,
            fee: POOL_FEE,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = ISwapRouter02(SWAP_ROUTER).exactInputSingle(params);
    }

    /// @dev Buy CLAWD <- USDC via SwapRouter02 with TWAP-anchored min-out guard.
    function _buyCLAWD(uint256 amountIn, uint256 twapUsdcPerClawd) internal returns (uint256 amountOut) {
        // Expected CLAWD out = amountIn (USDC, 6 dec) / twap (USDC/CLAWD, 6-dec scaled) * 1e18
        //                    = amountIn * 1e18 / twap
        uint256 expectedOut = (amountIn * 1e18) / twapUsdcPerClawd;
        uint256 minOut = (expectedOut * (10000 - maxSlippageBps)) / 10000;
        require(minOut > 0, "minOut=0");

        IERC20(USDC).forceApprove(SWAP_ROUTER, amountIn);

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn: USDC,
            tokenOut: CLAWD,
            fee: POOL_FEE,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = ISwapRouter02(SWAP_ROUTER).exactInputSingle(params);
    }
}
