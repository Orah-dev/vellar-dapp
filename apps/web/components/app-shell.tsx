"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LpActionButton, cx } from "@/app/landing/ui";
import { useWalletActions, useWalletSession, useWalletStatus } from "@/lib/wallet-context";
import { ChevronIcon, CopyIcon } from "./icons";
import "@/app/landing/landing.css";
import "./app.css";

// App shell — "paper & signals" product chrome (components/app.css): a
// detached, collapsible floating sidebar (bottom tab bar on mobile) and a
// top bar with the address chip, network label and page actions.
// AppShell guards the session and redirects to /app when signed out;
// AppShellView is the pure presentational layer (also used by /dev-ui).

const SIDEBAR_KEY = "vellar.sidebar";

const nav = [
  { href: "/dashboard", label: "Wallet", icon: <WalletIcon /> },
  { href: "/send", label: "Send / Swap", icon: <SwapIcon /> },
  { href: "/policies", label: "Policies", icon: <ShieldIcon /> },
  { href: "/verify", label: "Verify", icon: <BadgeCheckIcon /> },
  { href: "/cleanup", label: "Clean up", icon: <BroomIcon /> },
  { href: "/settings", label: "Settings", icon: <GearIcon /> },
];

export interface ShellAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export function AppShellView({
  children,
  actions,
  accountId,
  network,
  onDisconnect,
  activePath,
}: {
  children: ReactNode;
  actions?: ShellAction[];
  accountId: string;
  network: string;
  onDisconnect: () => void;
  activePath: string;
}) {
  const short = `${accountId.slice(0, 5)}…${accountId.slice(-5)}`;

  // Collapsed state persists per browser; unavailable storage means default.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
    } catch {
      /* default stays expanded */
    }
  }, []);
  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
      } catch {
        /* non-persistent is fine */
      }
      return next;
    });
  }

  return (
    <div className={cx("lp lpa", collapsed && "lpa-collapsed")}>
      {/* Detached sidebar (→ bottom tab bar on mobile) */}
      <aside className="lpa-side">
        <div className="lpa-side-top">
          <button
            className="lpa-collapse"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            <ChevronIcon dir={collapsed ? "right" : "left"} />
          </button>
        </div>
        {nav.map((item) => {
          const active = activePath === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`lpa-navitem${active ? " active" : ""}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </aside>

      {/* Main column */}
      <div className="lpa-main">
        <header className="lpa-top">
          <div className="flex items-center gap-3">
            <button
              className="lpa-chip-btn"
              onClick={() => void navigator.clipboard.writeText(accountId)}
              title={`${accountId} · click to copy`}
            >
              {short} <CopyIcon size={13} />
            </button>
            <p className="lpa-net">{network} network</p>
          </div>

          <div className="lpa-top-actions">
            {actions?.map((a) => (
              <LpActionButton
                key={a.label}
                onClick={a.onClick}
                variant={a.primary ? "sun" : "outline"}
                size="sm"
              >
                {a.label}
              </LpActionButton>
            ))}
            <LpActionButton onClick={onDisconnect} variant="outline" size="sm">
              Disconnect
            </LpActionButton>
          </div>
        </header>

        <main className="lpa-content">{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children, actions }: { children: ReactNode; actions?: ShellAction[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useWalletStatus();
  const session = useWalletSession();
  const walletActions = useWalletActions();

  useEffect(() => {
    if (status === "disconnected") router.replace("/app");
  }, [status, router]);

  if (status !== "connected" || !session) {
    return (
      <main className="lp lpa" style={{ display: "block", padding: 120 }}>
        <span style={{ color: "var(--lp-ink-soft)" }}>
          {status === "loading" ? "Restoring your session…" : "Redirecting…"}
        </span>
      </main>
    );
  }

  return (
    <AppShellView
      actions={actions}
      accountId={session.accountId}
      network={session.network}
      onDisconnect={() => void walletActions.disconnect()}
      activePath={pathname}
    >
      {children}
    </AppShellView>
  );
}

/* Line icons: stroke currentColor, 2px */
function WalletIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18M16 14h.01" />
    </svg>
  );
}
function SwapIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 8h14l-4-4M20 16H6l4 4" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function BadgeCheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l2.4 1.8 3 .1 1 2.8 2.4 1.8-.9 2.9.9 2.9-2.4 1.8-1 2.8-3 .1L12 22l-2.4-1.8-3-.1-1-2.8L3.2 15.5l.9-2.9-.9-2.9 2.4-1.8 1-2.8 3-.1L12 2z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function BroomIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M19 4l-7 7M6 20l-2-2 6-6 4 4-6 6-2-2zM10 14l4 4" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}
