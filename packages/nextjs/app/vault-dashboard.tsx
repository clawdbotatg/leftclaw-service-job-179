"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { NextPage } from "next";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { base } from "viem/chains";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Address } from "@scaffold-ui/components";
import { useScaffoldReadContract, useScaffoldWriteContract, useScaffoldEventHistory } from "~~/hooks/scaffold-eth";
import { useWriteAndOpen } from "~~/hooks/scaffold-eth/useWriteAndOpen";
import { notification } from "~~/utils/scaffold-eth";
import * as XLSX from "xlsx";

const VAULT_ADDRESS = "0xd5202071b4705c1b4ae5df42867d02585b07aa70";
const CLAWD_ADDRESS = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function fmtClawd(val: bigint | undefined): string {
  if (val == null) return "—";
  return parseFloat(formatUnits(val, 18)).toFixed(4);
}

function fmtUsdc(val: bigint | undefined): string {
  if (val == null) return "—";
  return parseFloat(formatUnits(val, 6)).toFixed(2);
}

function fmtPrice(val: bigint | undefined): string {
  if (val == null) return "—";
  return (Number(val) / 1e6).toFixed(6);
}

function fmtBps(val: bigint | undefined): string {
  if (val == null) return "—";
  return (Number(val) / 100).toFixed(2) + "%";
}

function fmtSeconds(val: bigint | number | undefined): string {
  if (val == null) return "—";
  const s = Number(val);
  return s >= 3600 ? `${s / 3600}h` : `${s / 60}min`;
}

const VaultDashboard: NextPage = () => {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { openConnectModal } = useConnectModal();

  // ─── Vault reads ────────────────────────────────────────────────────────────
  const { data: balances, refetch: refetchBalances } = useScaffoldReadContract({
    contractName: "CLAWDVault",
    functionName: "getVaultBalances",
  });
  const clawdBal = balances?.[0];
  const usdcBal = balances?.[1];

  const { data: spotPrice } = useScaffoldReadContract({
    contractName: "CLAWDVault",
    functionName: "getSpotPrice",
  });
  const { data: twapPrice } = useScaffoldReadContract({
    contractName: "CLAWDVault",
    functionName: "getTWAP",
  });
  const { data: ownerAddr } = useScaffoldReadContract({
    contractName: "CLAWDVault",
    functionName: "owner",
  });
  const { data: pumpBps } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "pumpThresholdBps" });
  const { data: dipBps } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "dipThresholdBps" });
  const { data: sellPct } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "sellPct" });
  const { data: buyPct } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "buyPct" });
  const { data: twapWindow } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "twapWindow" });
  const { data: maxSlippage } = useScaffoldReadContract({ contractName: "CLAWDVault", functionName: "maxSlippageBps" });

  const isOwner = isConnected && !!address && !!ownerAddr &&
    address.toLowerCase() === (ownerAddr as string).toLowerCase();
  const isBase = chainId === base.id;

  // ─── Zone status ────────────────────────────────────────────────────────────
  const getZone = (): { label: string; cls: string } => {
    if (spotPrice == null || twapPrice == null || pumpBps == null || dipBps == null)
      return { label: "LOADING", cls: "badge-neutral" };
    const pump = twapPrice + (twapPrice * pumpBps) / 10000n;
    const dip = twapPrice > (twapPrice * dipBps) / 10000n
      ? twapPrice - (twapPrice * dipBps) / 10000n
      : 0n;
    if (spotPrice >= pump) return { label: "PUMP ZONE 🔴", cls: "badge-error" };
    if (spotPrice <= dip) return { label: "DIP ZONE 🟢", cls: "badge-success" };
    return { label: "NEUTRAL ⚪", cls: "badge-neutral" };
  };
  const zone = getZone();

  // ─── Trade history ──────────────────────────────────────────────────────────
  const { data: swapEvents } = useScaffoldEventHistory({
    contractName: "CLAWDVault",
    eventName: "SwapExecuted",
    fromBlock: 0n,
    watch: true,
  });

  // ─── Config form ────────────────────────────────────────────────────────────
  const [cfgPump, setCfgPump] = useState("");
  const [cfgDip, setCfgDip] = useState("");
  const [cfgSell, setCfgSell] = useState("");
  const [cfgBuy, setCfgBuy] = useState("");
  const [cfgTwap, setCfgTwap] = useState("");
  const [cfgSlip, setCfgSlip] = useState("");

  const { writeContractAsync: writeSetParams, isPending: isSettingParams } = useScaffoldWriteContract({
    contractName: "CLAWDVault",
  });
  const { writeContractAsync: writeDeposit, isPending: isDepositing } = useScaffoldWriteContract({
    contractName: "CLAWDVault",
  });
  const { writeContractAsync: writeWithdraw, isPending: isWithdrawing } = useScaffoldWriteContract({
    contractName: "CLAWDVault",
  });
  const { writeContractAsync: writeApproveClawd, isPending: isApprovingClawd } = useScaffoldWriteContract({
    contractName: "CLAWD",
  });
  const { writeContractAsync: writeApproveUsdc, isPending: isApprovingUsdc } = useScaffoldWriteContract({
    contractName: "USDC",
  });

  const { writeAndOpen } = useWriteAndOpen();

  // ─── Deposit/Withdraw state ─────────────────────────────────────────────────
  const [clawdAmount, setClawdAmount] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [clawdApprSubmitting, setClawdApprSubmitting] = useState(false);
  const [clawdApprCooldown, setClawdApprCooldown] = useState(false);
  const [usdcApprSubmitting, setUsdcApprSubmitting] = useState(false);
  const [usdcApprCooldown, setUsdcApprCooldown] = useState(false);

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  const safeAddress = (address as `0x${string}`) ?? ZERO_ADDR;

  const { data: clawdAllowance, refetch: refetchClawdAllowance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "allowance",
    args: [safeAddress, VAULT_ADDRESS as `0x${string}`],
  });
  const { data: usdcAllowance, refetch: refetchUsdcAllowance } = useScaffoldReadContract({
    contractName: "USDC",
    functionName: "allowance",
    args: [safeAddress, VAULT_ADDRESS as `0x${string}`],
  });

  const clawdAmtParsed = clawdAmount ? parseUnits(clawdAmount, 18) : 0n;
  const usdcAmtParsed = usdcAmount ? parseUnits(usdcAmount, 6) : 0n;
  const needsClawdApproval = clawdAmtParsed > 0n && (clawdAllowance ?? 0n) < clawdAmtParsed;
  const needsUsdcApproval = usdcAmtParsed > 0n && (usdcAllowance ?? 0n) < usdcAmtParsed;

  // ─── Handlers ───────────────────────────────────────────────────────────────
  const handleSaveConfig = async () => {
    try {
      await writeAndOpen(() =>
        writeSetParams({
          functionName: "setParameters",
          args: [
            BigInt(cfgPump || String(pumpBps ?? 500n)),
            BigInt(cfgDip || String(dipBps ?? 500n)),
            BigInt(cfgSell || String(sellPct ?? 20n)),
            BigInt(cfgBuy || String(buyPct ?? 20n)),
            (Number(cfgTwap || String(twapWindow ?? 1800))) as unknown as number,
            BigInt(cfgSlip || String(maxSlippage ?? 100n)),
          ],
        })
      );
      notification.success("Parameters updated");
    } catch {
      notification.error("Failed to update parameters");
    }
  };

  const handleClawdApprove = async () => {
    if (clawdApprSubmitting || clawdApprCooldown) return;
    setClawdApprSubmitting(true);
    try {
      await writeAndOpen(() =>
        writeApproveClawd({ functionName: "approve", args: [VAULT_ADDRESS as `0x${string}`, clawdAmtParsed] })
      );
      setClawdApprCooldown(true);
      setTimeout(() => { setClawdApprCooldown(false); void refetchClawdAllowance(); }, 4000);
    } catch { notification.error("CLAWD approval failed"); }
    finally { setClawdApprSubmitting(false); }
  };

  const handleUsdcApprove = async () => {
    if (usdcApprSubmitting || usdcApprCooldown) return;
    setUsdcApprSubmitting(true);
    try {
      await writeAndOpen(() =>
        writeApproveUsdc({ functionName: "approve", args: [VAULT_ADDRESS as `0x${string}`, usdcAmtParsed] })
      );
      setUsdcApprCooldown(true);
      setTimeout(() => { setUsdcApprCooldown(false); void refetchUsdcAllowance(); }, 4000);
    } catch { notification.error("USDC approval failed"); }
    finally { setUsdcApprSubmitting(false); }
  };

  const handleDeposit = async (token: `0x${string}`, amt: bigint) => {
    try {
      await writeAndOpen(() =>
        writeDeposit({ functionName: "deposit", args: [token, amt] })
      );
      notification.success("Deposited");
      void refetchBalances();
    } catch { notification.error("Deposit failed"); }
  };

  const handleWithdraw = async (token: `0x${string}`, amt: bigint) => {
    try {
      await writeAndOpen(() =>
        writeWithdraw({ functionName: "withdraw", args: [token, amt] })
      );
      notification.success("Withdrawn");
      void refetchBalances();
    } catch { notification.error("Withdraw failed"); }
  };

  // ─── CSV Export ──────────────────────────────────────────────────────────────
  const handleExportCSV = () => {
    if (!swapEvents?.length) { notification.error("No trades to export"); return; }
    const rows = swapEvents.map(ev => ({
      Direction: ev.args.direction ?? "",
      "CLAWD Amount": ev.args.direction === "sell"
        ? fmtClawd(ev.args.amountIn)
        : fmtClawd(ev.args.amountOut),
      "USDC Amount": ev.args.direction === "buy"
        ? fmtUsdc(ev.args.amountIn)
        : fmtUsdc(ev.args.amountOut),
      "Spot Price (USDC/CLAWD)": fmtPrice(ev.args.spotPrice),
      "TWAP Price (USDC/CLAWD)": fmtPrice(ev.args.twapPrice),
      Timestamp: ev.args.timestamp
        ? new Date(Number(ev.args.timestamp) * 1000).toISOString()
        : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Trades");
    XLSX.writeFile(wb, "clawd-vault-trades.csv");
  };

  // ─── Wallet gate ────────────────────────────────────────────────────────────
  const ConnectBtn = () => (
    <button className="btn btn-primary" onClick={() => openConnectModal?.()}>Connect Wallet</button>
  );
  const SwitchBtn = () => (
    <button className="btn btn-warning" onClick={() => switchChain({ chainId: base.id })}>Switch to Base</button>
  );

  return (
    <div className="flex flex-col gap-6 py-8 px-4 max-w-5xl mx-auto">

      {/* ── Section 1: Vault Status ──────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow-xl">
        <div className="card-body">
          <h2 className="card-title text-2xl">🦀 CLAWD Vault Status</h2>
          <div className="text-sm text-base-content/60 mb-2 flex items-center gap-2">
            <span>Contract:</span>
            <Address address={VAULT_ADDRESS} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
            <div className="stat bg-base-100 rounded-box p-4">
              <div className="stat-title">CLAWD Balance</div>
              <div className="stat-value text-lg font-mono">{fmtClawd(clawdBal)}</div>
              <div className="stat-desc">CLAWD tokens</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-4">
              <div className="stat-title">USDC Balance</div>
              <div className="stat-value text-lg font-mono">{fmtUsdc(usdcBal)}</div>
              <div className="stat-desc">USDC</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-4">
              <div className="stat-title">Spot Price</div>
              <div className="stat-value text-lg font-mono">{fmtPrice(spotPrice)}</div>
              <div className="stat-desc">USDC/CLAWD</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-4">
              <div className="stat-title">TWAP (30m)</div>
              <div className="stat-value text-lg font-mono">{fmtPrice(twapPrice)}</div>
              <div className="stat-desc">USDC/CLAWD</div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <span className="font-semibold">Market Zone:</span>
            <span className={`badge badge-lg ${zone.cls}`}>{zone.label}</span>
          </div>

          {swapEvents && swapEvents.length > 0 && (
            <div className="mt-2 text-sm text-base-content/60">
              Last trade: <strong>{swapEvents[0]?.args.direction?.toUpperCase()}</strong> at{" "}
              {fmtPrice(swapEvents[0]?.args.spotPrice)} USDC/CLAWD
            </div>
          )}
        </div>
      </div>

      {/* ── Section 2: Config Panel ──────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow-xl">
        <div className="card-body">
          <h2 className="card-title">⚙️ Strategy Parameters</h2>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-2">
            {([
              ["Pump Threshold", pumpBps, fmtBps],
              ["Dip Threshold", dipBps, fmtBps],
              ["Sell %", sellPct, (v: bigint | undefined) => v != null ? `${v}%` : "—"],
              ["Buy %", buyPct, (v: bigint | undefined) => v != null ? `${v}%` : "—"],
              ["TWAP Window", twapWindow, fmtSeconds],
              ["Max Slippage", maxSlippage, fmtBps],
            ] as [string, bigint | undefined, (v: bigint | undefined) => string][]).map(([label, value, fmt]) => (
              <div key={label} className="bg-base-100 rounded-box p-3">
                <div className="text-xs text-base-content/60">{label}</div>
                <div className="font-mono font-semibold">{fmt(value)}</div>
              </div>
            ))}
          </div>

          {!isConnected && (
            <div className="mt-4">
              <ConnectBtn />
            </div>
          )}
          {isConnected && !isBase && (
            <div className="mt-4">
              <SwitchBtn />
            </div>
          )}
          {isConnected && isBase && isOwner && (
            <div className="mt-4">
              <h3 className="font-semibold mb-2">Edit Parameters</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {([
                  ["Pump Threshold (bps)", cfgPump, setCfgPump, pumpBps],
                  ["Dip Threshold (bps)", cfgDip, setCfgDip, dipBps],
                  ["Sell % (1–100)", cfgSell, setCfgSell, sellPct],
                  ["Buy % (1–100)", cfgBuy, setCfgBuy, buyPct],
                  ["TWAP Window (sec ≥1800)", cfgTwap, setCfgTwap, twapWindow],
                  ["Max Slippage (bps)", cfgSlip, setCfgSlip, maxSlippage],
                ] as [string, string, Dispatch<SetStateAction<string>>, bigint | undefined][]).map(
                  ([label, val, setter, def]) => (
                    <label key={label} className="form-control">
                      <div className="label"><span className="label-text text-xs">{label}</span></div>
                      <input
                        type="number"
                        className="input input-bordered input-sm"
                        placeholder={def != null ? String(def) : ""}
                        value={val}
                        onChange={e => setter(e.target.value)}
                      />
                    </label>
                  )
                )}
              </div>
              <button
                className="btn btn-primary mt-4"
                onClick={handleSaveConfig}
                disabled={isSettingParams}
              >
                {isSettingParams ? <span className="loading loading-spinner loading-sm" /> : null}
                Save Changes
              </button>
            </div>
          )}
          {isConnected && isBase && !isOwner && (
            <p className="mt-3 text-sm text-base-content/60">Connect as vault owner to edit parameters.</p>
          )}
        </div>
      </div>

      {/* ── Section 3: Deposit / Withdraw ────────────────────────────────────── */}
      <div className="card bg-base-200 shadow-xl">
        <div className="card-body">
          <h2 className="card-title">💰 Deposit / Withdraw</h2>

          {!isConnected && <div className="mt-2"><ConnectBtn /></div>}
          {isConnected && !isBase && <div className="mt-2"><SwitchBtn /></div>}
          {isConnected && isBase && !isOwner && (
            <div className="alert alert-info text-sm mt-2">Only the vault owner can deposit or withdraw.</div>
          )}

          {isConnected && isBase && isOwner && (
            <div className="grid md:grid-cols-2 gap-6 mt-4">
              {/* CLAWD */}
              <div className="bg-base-100 rounded-box p-4">
                <h3 className="font-semibold mb-3">CLAWD</h3>
                <input
                  type="number"
                  step="any"
                  min="0"
                  className="input input-bordered w-full mb-3"
                  placeholder="Amount (CLAWD)"
                  value={clawdAmount}
                  onChange={e => setClawdAmount(e.target.value)}
                />
                <div className="flex gap-2">
                  {needsClawdApproval ? (
                    <button
                      className="btn btn-warning flex-1"
                      disabled={isApprovingClawd || clawdApprSubmitting || clawdApprCooldown}
                      onClick={handleClawdApprove}
                    >
                      {(clawdApprSubmitting || isApprovingClawd) ? <span className="loading loading-spinner loading-sm" /> : null}
                      {clawdApprCooldown ? "Confirming..." : "Approve CLAWD"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-success flex-1"
                      disabled={isDepositing || !clawdAmtParsed}
                      onClick={() => handleDeposit(CLAWD_ADDRESS as `0x${string}`, clawdAmtParsed)}
                    >
                      {isDepositing ? <span className="loading loading-spinner loading-sm" /> : null}
                      Deposit
                    </button>
                  )}
                  <button
                    className="btn btn-error flex-1"
                    disabled={isWithdrawing || !clawdAmtParsed}
                    onClick={() => handleWithdraw(CLAWD_ADDRESS as `0x${string}`, clawdAmtParsed)}
                  >
                    {isWithdrawing ? <span className="loading loading-spinner loading-sm" /> : null}
                    Withdraw
                  </button>
                </div>
              </div>

              {/* USDC */}
              <div className="bg-base-100 rounded-box p-4">
                <h3 className="font-semibold mb-3">USDC</h3>
                <input
                  type="number"
                  step="any"
                  min="0"
                  className="input input-bordered w-full mb-3"
                  placeholder="Amount (USDC)"
                  value={usdcAmount}
                  onChange={e => setUsdcAmount(e.target.value)}
                />
                <div className="flex gap-2">
                  {needsUsdcApproval ? (
                    <button
                      className="btn btn-warning flex-1"
                      disabled={isApprovingUsdc || usdcApprSubmitting || usdcApprCooldown}
                      onClick={handleUsdcApprove}
                    >
                      {(usdcApprSubmitting || isApprovingUsdc) ? <span className="loading loading-spinner loading-sm" /> : null}
                      {usdcApprCooldown ? "Confirming..." : "Approve USDC"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-success flex-1"
                      disabled={isDepositing || !usdcAmtParsed}
                      onClick={() => handleDeposit(USDC_ADDRESS as `0x${string}`, usdcAmtParsed)}
                    >
                      {isDepositing ? <span className="loading loading-spinner loading-sm" /> : null}
                      Deposit
                    </button>
                  )}
                  <button
                    className="btn btn-error flex-1"
                    disabled={isWithdrawing || !usdcAmtParsed}
                    onClick={() => handleWithdraw(USDC_ADDRESS as `0x${string}`, usdcAmtParsed)}
                  >
                    {isWithdrawing ? <span className="loading loading-spinner loading-sm" /> : null}
                    Withdraw
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Section 4: Trade History ─────────────────────────────────────────── */}
      <div className="card bg-base-200 shadow-xl">
        <div className="card-body">
          <div className="flex items-center justify-between">
            <h2 className="card-title">📊 Trade History</h2>
            <button
              className="btn btn-sm btn-outline"
              onClick={handleExportCSV}
              disabled={!swapEvents?.length}
            >
              Export CSV
            </button>
          </div>

          {!swapEvents?.length ? (
            <p className="text-base-content/60 text-sm mt-2">
              No trades yet. Chainlink Automation will trigger swaps when price deviates from TWAP.
            </p>
          ) : (
            <div className="overflow-x-auto mt-2">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>CLAWD</th>
                    <th>USDC</th>
                    <th>Spot (USDC/CLAWD)</th>
                    <th>TWAP (USDC/CLAWD)</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {swapEvents.map((ev, i) => {
                    const isSell = ev.args.direction === "sell";
                    return (
                      <tr key={i}>
                        <td>
                          <span className={`badge ${isSell ? "badge-error" : "badge-success"}`}>
                            {isSell ? "SELL" : "BUY"}
                          </span>
                        </td>
                        <td className="font-mono text-xs">
                          {isSell ? fmtClawd(ev.args.amountIn) : fmtClawd(ev.args.amountOut)}
                        </td>
                        <td className="font-mono text-xs">
                          {isSell ? fmtUsdc(ev.args.amountOut) : fmtUsdc(ev.args.amountIn)}
                        </td>
                        <td className="font-mono text-xs">{fmtPrice(ev.args.spotPrice)}</td>
                        <td className="font-mono text-xs">{fmtPrice(ev.args.twapPrice)}</td>
                        <td className="text-xs text-base-content/60">
                          {ev.args.timestamp
                            ? new Date(Number(ev.args.timestamp) * 1000).toLocaleString()
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default VaultDashboard;
