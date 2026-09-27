"use client";

import { useMemo, useState } from "react";
import type { Network } from "@vellar/types";
import { Eyebrow, LpActionButton } from "@/app/landing/ui";
import { CopyIcon } from "@/components/icons";
import { QrCode } from "@/components/qr-code";
import { assetsFor, findAssetById } from "@/lib/assets";
import { walletConfig } from "@/lib/config";
import { buildPayUri, Sep7Error } from "@/lib/sep7";

// Receive panel: the smart-account (C…) address with one-tap copy, and a QR
// that carries either the bare address or a SEP-7 payment request with an
// optional asset/amount/memo. The QR is encoded on-device (lib/qr.ts).

type QrMode = "request" | "address";

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [
    copied,
    (key, text) => {
      navigator.clipboard.writeText(text).then(
        () => setCopied(key),
        () => setCopied(`${key}:failed`),
      );
    },
  ];
}

export function ReceiveCard({
  accountId,
  network,
  onClose,
}: {
  accountId: string;
  network: Network;
  onClose: () => void;
}) {
  const assets = assetsFor(network);
  const [assetId, setAssetId] = useState("native");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [mode, setMode] = useState<QrMode>("request");
  const [copied, copy] = useCopy();

  const request = useMemo(() => {
    try {
      const uri = buildPayUri({
        destination: accountId,
        network,
        networkPassphrase: walletConfig().networkPassphrase,
        asset: findAssetById(network, assetId),
        amount: amount.trim(),
        memo: memo.trim(),
      });
      return { uri, error: null };
    } catch (err) {
      return { uri: null, error: err instanceof Sep7Error ? err.message : "Invalid request." };
    }
  }, [accountId, network, assetId, amount, memo]);

  const payload = mode === "address" ? accountId : request.uri;

  return (
    <section className="lpa-panel">
      <div className="flex items-center justify-between">
        <Eyebrow>Receive</Eyebrow>
        <button className="lpa-chip-btn" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      <p className="mt-3! text-sm text-[var(--lp-ink-soft)]">
        Send Stellar assets to this smart-account address.
      </p>
      <div className="lpa-well mt-3">
        <span className="flabel block text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--lp-ink-faint)]">
          YOUR ADDRESS
        </span>
        <p
          data-testid="receive-address"
          className="mt-1.5! break-all font-[family-name:var(--lp-mono)] text-[13px]"
        >
          {accountId}
        </p>
      </div>
      <LpActionButton className="mt-3" onClick={() => copy("address", accountId)}>
        <CopyIcon />{" "}
        {copied === "address"
          ? "Copied"
          : copied === "address:failed"
            ? "Copy failed — select the address"
            : "Copy address"}
      </LpActionButton>

      <div className="mt-5 flex flex-col gap-3">
        <Eyebrow>Request a payment</Eyebrow>
        <label className="lpa-field">
          <span className="flabel">Asset</span>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.symbol} — {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="lpa-field">
          <span className="flabel">Amount (optional)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Payer chooses"
            inputMode="decimal"
          />
        </label>
        <label className="lpa-field">
          <span className="flabel">Memo (optional, up to 28 bytes)</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={28} />
        </label>
        {request.error && (
          <p role="alert" className="lpa-bad text-sm">
            {request.error}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-col items-start gap-3">
        <div role="radiogroup" aria-label="QR contents" className="flex gap-2">
          {(
            [
              ["request", "Payment request"],
              ["address", "Address only"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={`lpa-chip-btn ${mode === value ? "font-bold" : ""}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {payload && (
          <>
            <QrCode
              value={payload}
              label={
                mode === "address" ? "QR code of your address" : "QR code of your payment request"
              }
            />
            {mode === "request" && (
              <>
                <p
                  data-testid="receive-uri"
                  className="break-all font-[family-name:var(--lp-mono)] text-[11px] text-[var(--lp-ink-faint)]"
                >
                  {payload}
                </p>
                <LpActionButton variant="outline" size="sm" onClick={() => copy("uri", payload)}>
                  <CopyIcon />{" "}
                  {copied === "uri"
                    ? "Copied"
                    : copied === "uri:failed"
                      ? "Copy failed"
                      : "Copy payment link"}
                </LpActionButton>
              </>
            )}
          </>
        )}

        <p className="text-[12px] leading-relaxed text-[var(--lp-ink-soft)]">
          This is a smart-account (C…) address. The payer&apos;s wallet must support sending to
          contract addresses; wallets limited to classic G… accounts will refuse the request rather
          than send it elsewhere.
        </p>
      </div>
    </section>
  );
}
