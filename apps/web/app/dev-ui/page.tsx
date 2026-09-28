"use client";

import { notFound } from "next/navigation";
import { AppShellView } from "@/components/app-shell";
import { Chips, Eyebrow, LpActionButton } from "@/app/landing/ui";
import { ReceiveCard } from "../dashboard/receive-card";

// Dev-only kitchen sink for the app UI kit (components/app.css): renders the
// shell and every product primitive with fixture data so the design can be
// reviewed and screenshotted without a live wallet session. 404s in prod.

const ACCOUNT = "CDW3KQPZ64ZKLXWMB2VXYRT6MLKW2GVQ5FDEMVXJ4EBTHVVJ67K7QPAB";

export default function DevUi() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <AppShellView
      accountId={ACCOUNT}
      network="testnet"
      activePath="/dashboard"
      onDisconnect={() => {}}
      actions={[
        { label: "Send", onClick: () => {}, primary: true },
        { label: "Receive", onClick: () => {} },
      ]}
    >
      <div className="grid items-start gap-5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {/* Balance panel */}
        <section className="lpa-panel flex flex-col">
          <Eyebrow>Account balance</Eyebrow>
          <div className="lpa-balance mt-2.5">
            10,024.5 <span className="unit">XLM</span>
          </div>
          <dl className="lpa-detail mt-6">
            <div className="lpa-detail-row">
              <dt>Account name</dt>
              <dd>67K7QPAB</dd>
            </div>
            <div className="lpa-detail-row">
              <dt>Public key</dt>
              <dd className="font-[family-name:var(--lp-mono)] text-[13px]">CDW3KQ…K7QPAB</dd>
            </div>
            <div className="lpa-detail-row">
              <dt>Network</dt>
              <dd className="capitalize">testnet</dd>
            </div>
            <div className="lpa-detail-row">
              <dt>Auth method</dt>
              <dd>Passkey</dd>
            </div>
          </dl>
        </section>

        {/* Assets */}
        <section className="lpa-panel min-h-[260px]">
          <Eyebrow>My assets</Eyebrow>
          <div className="mt-1.5">
            <div className="lpa-tokrow">
              <div className="ti"></div>
              <div className="tn">
                <b>Stellar Lumens</b>
                <span>XLM</span>
              </div>
              <div className="tv">
                <b className="lpa-amt text-base">10,024.5</b>
              </div>
            </div>
            <div className="lpa-tokrow">
              <div className="ti"></div>
              <div className="tn">
                <b>USD Coin</b>
                <span>USDC</span>
              </div>
              <div className="tv">
                <b className="lpa-amt text-base">312.20</b>
              </div>
            </div>
          </div>
        </section>

        {/* Empty state */}
        <section className="lpa-panel min-h-[260px]">
          <Eyebrow>Activity</Eyebrow>
          <div className="lpa-empty mt-6">
            <div className="ph" />
            <p className="max-w-[200px] text-sm!">
              Transaction history arrives with a later wallet-core slice.
            </p>
            <LpActionButton variant="outline" size="sm" onClick={() => {}}>
              Receive assets
            </LpActionButton>
          </div>
        </section>

        {/* Send form replica */}
        <section className="lpa-panel">
          <Eyebrow>Send XLM</Eyebrow>
          <div className="mt-3.5 flex flex-col gap-3">
            <label className="lpa-field">
              <span className="flabel">Recipient</span>
              <input placeholder="G... or C..." defaultValue="" />
            </label>
            <label className="lpa-field">
              <span className="flabel">Amount (XLM)</span>
              <input placeholder="0.0" defaultValue="166.6" />
              <span className="ferror">Amount exceeds your balance</span>
            </label>
            <div className="flex gap-3">
              <LpActionButton onClick={() => {}}>Review payment</LpActionButton>
              <LpActionButton variant="outline" onClick={() => {}}>
                Cancel
              </LpActionButton>
            </div>
          </div>
        </section>

        {/* Review well replica */}
        <section className="lpa-panel">
          <Eyebrow>Review</Eyebrow>
          <div className="mt-3.5 flex flex-col gap-3">
            <span className="lpa-ok self-start text-[13px] font-bold">
              ✓ Review before signing — this cannot be undone
            </span>
            <dl className="lpa-well flex flex-col gap-2.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--lp-ink-faint)]">To</dt>
                <dd className="break-all text-right font-[family-name:var(--lp-mono)] text-xs">
                  GB4XLKJH…R2D9F2A
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--lp-ink-faint)]">Amount</dt>
                <dd className="lpa-amt text-xl">166.6 XLM</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--lp-ink-faint)]">Network</dt>
                <dd className="uppercase">testnet</dd>
              </div>
            </dl>
            <p className="lpa-bad text-sm">Payment failed on the network.</p>
            <Chips
              items={[
                { label: "Spend limit", on: true },
                { label: "Verified only", on: true },
                { label: "Revoke" },
              ]}
            />
          </div>
        </section>

        {/* Receive (real component) */}
        <ReceiveCard accountId={ACCOUNT} network="testnet" onClose={() => {}} />
      </div>
    </AppShellView>
  );
}
