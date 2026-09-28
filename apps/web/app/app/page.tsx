import Link from "next/link";
import { Eyebrow, Frame } from "../landing/ui";
import { OnboardingActions } from "../onboarding-actions";
import "../landing/landing.css";
import "@/components/app.css";

// Wallet entry (/app): passkey onboarding (design.md §7) on the
// "paper & signals" system. The marketing landing lives at /.

export default function AppEntry() {
  return (
    <main className="lp lpa lpa-auth">
      <Link
        href="/"
        className="font-[family-name:var(--lp-mono)] text-xs font-bold text-[var(--lp-ink-faint)]"
      >
        ← vellar.xyz
      </Link>
      <div className="mx-auto mt-12 max-w-[560px] text-center">
        <Eyebrow>Wallet · testnet</Eyebrow>
        <h1 className="mt-5! text-[length:var(--lp-fs-h2)]! tracking-[-0.02em]!">
          Step into your wallet.
        </h1>
        <p className="mx-auto mt-4! max-w-[46ch] text-base leading-relaxed text-[var(--lp-ink-soft)]">
          Create a smart account with a passkey, or sign back in with the one you already have. No
          seed phrase, no password, just you.
        </p>
      </div>
      <Frame className="mx-auto mt-9 max-w-[480px]">
        <div className="lpa-panel">
          <OnboardingActions />
        </div>
      </Frame>
    </main>
  );
}
