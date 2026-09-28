"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Eyebrow, LpActionButton, LpButton } from "@/app/landing/ui";
import { SendPayment } from "@/app/dashboard/send-payment";
import { walletConfig } from "@/lib/config";
import {
  parsePayUri,
  verifySep7Origin,
  type OriginVerification,
  type Sep7PayRequest,
} from "@/lib/sep7";
import { useWalletSession } from "@/lib/wallet-context";

// Incoming SEP-7 payment requests (issue #402). Reached from a
// web+stellar:pay link (registered protocol handler: /pay?uri=%s) or by
// pasting a request. The URI is untrusted: it is parsed deny-by-default,
// its claimed origin is verified per SEP-7, and a valid request only
// PREFILLS the normal send flow — review + passkey confirmation still gate
// every payment. Nothing here signs or submits.

const KEY_CACHE = "vellar.sep7.signingKeys";

const keyCache = {
  get(domain: string): string | null {
    try {
      const map = JSON.parse(localStorage.getItem(KEY_CACHE) ?? "{}") as Record<string, string>;
      return typeof map[domain] === "string" ? map[domain] : null;
    } catch {
      return null;
    }
  },
  set(domain: string, key: string) {
    try {
      const map = JSON.parse(localStorage.getItem(KEY_CACHE) ?? "{}") as Record<string, string>;
      map[domain] = key;
      localStorage.setItem(KEY_CACHE, JSON.stringify(map));
    } catch {
      /* verification still happened; only change-detection is lost */
    }
  },
};

type Intake =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "rejected"; error: string }
  | { state: "verifying"; request: Sep7PayRequest }
  | { state: "ready"; request: Sep7PayRequest; origin: OriginVerification };

export default function PayPage() {
  const session = useWalletSession();
  const [raw, setRaw] = useState<string | null | undefined>(undefined);
  const [intake, setIntake] = useState<Intake>({ state: "loading" });
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    setRaw(new URLSearchParams(window.location.search).get("uri"));
  }, []);

  useEffect(() => {
    if (raw === undefined || !session) return;
    if (raw === null || raw.trim() === "") {
      setIntake({ state: "empty" });
      return;
    }
    const parsed = parsePayUri(raw, {
      network: session.network,
      networkPassphrase: walletConfig().networkPassphrase,
    });
    if (!parsed.ok) {
      setIntake({ state: "rejected", error: parsed.error });
      return;
    }
    const request = parsed.request;
    setIntake({ state: "verifying", request });
    let cancelled = false;
    void verifySep7Origin(request, {
      fetch: (url) => fetch(url, { credentials: "omit" }),
      keyCache,
    }).then((origin) => {
      if (cancelled) return;
      if (origin.status === "invalid") {
        setIntake({ state: "rejected", error: `Can't pay this request: ${origin.reason}` });
      } else {
        setIntake({ state: "ready", request, origin });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [raw, session]);

  return (
    <AppShell>
      <div className="max-w-[460px]">
        {intake.state === "loading" && (
          <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">Loading…</p>
        )}

        {intake.state === "empty" && (
          <section className="lpa-panel flex flex-col gap-3">
            <Eyebrow>Pay a request</Eyebrow>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setRaw(pasted);
              }}
            >
              <label className="lpa-field">
                <span className="flabel">Payment request (web+stellar:pay…)</span>
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  rows={4}
                  spellCheck={false}
                />
              </label>
              <LpActionButton type="submit" className="self-start" disabled={!pasted.trim()}>
                Open request
              </LpActionButton>
            </form>
            <LpActionButton
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                try {
                  navigator.registerProtocolHandler(
                    "web+stellar",
                    `${window.location.origin}/pay?uri=%s`,
                  );
                } catch {
                  /* unsupported browser / context — pasting still works */
                }
              }}
            >
              Open web+stellar links with Vellar
            </LpActionButton>
          </section>
        )}

        {intake.state === "rejected" && (
          <section className="lpa-panel flex flex-col gap-3">
            <Eyebrow>Payment request rejected</Eyebrow>
            <p role="alert" className="lpa-bad text-sm">
              {intake.error}
            </p>
            <p className="text-[13px] text-[var(--lp-ink-soft)]">
              Nothing was signed or sent. Ask the requester for a new link.
            </p>
            <LpButton href="/dashboard" variant="outline" size="sm" className="self-start">
              Back to wallet
            </LpButton>
          </section>
        )}

        {intake.state === "verifying" && (
          <p className="animate-pulse text-sm text-[var(--lp-ink-faint)]">
            Checking the request&apos;s origin…
          </p>
        )}

        {intake.state === "ready" && session && (
          <SendPayment
            from={session.accountId}
            token={intake.request.asset}
            network={session.network}
            onSuccess={() => undefined}
            prefill={{
              to: intake.request.destination,
              ...(intake.request.amount !== undefined && { amount: intake.request.amount }),
            }}
            request={{
              originDomain: intake.origin.status === "verified" ? intake.origin.domain : null,
              ...(intake.request.msg !== undefined && { msg: intake.request.msg }),
            }}
          />
        )}
      </div>
    </AppShell>
  );
}
