# Design note — Restyle the policies page (`/policies`)

**Status:** PROPOSED
**Scope:** visual restyle of `apps/web/app/policies/page.tsx` to the app design system described in design.md §7 ("paper & signals" at product density, `components/app.css`). **No behaviour changes.** The flag gating, template → configure → review → deploy flow, validation and on-chain calls all stay exactly as they are.
**Tracks:** open-work-catalogue.md item 5.3 ("App pages restyled per design.md §7"). This note covers the policies page only.
**Grounding:** `apps/web/components/app.css` (the `.lpa` product layer), `apps/web/app/landing/landing.css` (the `.lp` tokens and primitives), and the already-migrated reference pages `app/dashboard/page.tsx` and `app/dashboard/send-payment.tsx`.

> design.md is gitignored (`.gitignore:45`), so this note restates the rules it relies on from the committed CSS rather than quoting §7. If §7 disagrees with anything here, §7 wins. Update this note to match.

---

## 1. Where the page is today

The page already sits inside the new `AppShell` and uses `.lpa-panel`, `.lpa-well` and `.lpa-field`, so it is legible. It still reads as a half-migrated page:

| Problem | Where |
| --- | --- |
| Inline Tailwind is used for type and colour (`text-[var(--lp-ink-soft)]`, `text-[13px]`, `font-[family-name:var(--lp-mono)]`) instead of the system's classes. There are 14 `lp-ink-soft` references. | throughout |
| The page header (`<h1>` plus lead paragraph) is copied into two components with ad-hoc `mt-3!` / `max-w-[560px]` spacing. | `PolicyBuilderNotYetAvailable`, `PolicyBuilder` |
| There is no visible stepper, so the three stages (pick → configure → review) are implicit. | `PolicyBuilder` |
| Template cards reuse `button.lpa-panel` but build the title, body and "Configure →" footer from one-off spans. "Coming soon" is only a faint text label. | `TemplatePicker` |
| The review card stacks 5–7 visually identical `.lpa-well` blocks (definition JSON, hash, cap summary, safety rules, provenance, success, detach). Nothing stands out, and success/removed states look the same as info. | `ReviewCard` |
| The mono uppercase label is re-implemented inline (`flabel block font-[…mono] text-[11px] font-bold uppercase tracking-[0.14em]`) instead of using the existing eyebrow style. | `ReviewCard` lines ~560–570 |
| Success is shown as a `✓` glyph in `.lpa-ok` text. It should use the shared trust/verified treatment (`.lp-verified`). | `ReviewCard` done/detached |

## 2. Target layout

```
┌ AppShell ───────────────────────────────────────────────┐
│  EYEBROW  Account policies                              │
│  H1       Guardrails, enforced on-chain                 │
│  lead     Spending limits, multisig, allowlists…        │
│                                                         │
│  [1 Choose template]──[2 Configure]──[3 Review & deploy]│  ← stepper
│                                                         │
│  stage body (one panel per stage)                       │
└─────────────────────────────────────────────────────────┘
```

### 2.1 Page header (shared)
- Pull the header into one `PolicyHeader` component used by both the rollout-gated state and the builder.
- Structure: `.lp-eyebrow` ("Account policies"), then `<h1>`, then a `.lp-lead` paragraph. Take spacing from the system classes and drop the `mt-3!` / `max-w-[560px]` overrides.
- Keep the exact text "Account policies" in the DOM, because `page.flag-gating.test.tsx` queries it.

### 2.2 Stepper
- New `PolicyStepper` built from the existing `.lp-chips` segmented control, **display-only** (not clickable, so it cannot skip validation). The active step uses the chip "on" state. Completed steps show a check.
- Render it as `<ol aria-label="Policy setup progress">` with `aria-current="step"` on the active item.
- Hide it in the rollout-gated state.

### 2.3 Stage 1 — template picker
- Keep the responsive grid (`minmax(220px, 1fr)`) and `button.lpa-panel` (it already provides the hover lift and disabled opacity).
- Card anatomy: a display-font title, a body in ink-soft, and a footer row. The footer shows the "Configure →" affordance, or a **`.lp-badge` reading "Coming soon"** for unavailable templates instead of faint text. Keep the literal "Coming soon" text for the tests.
- Loading: replace the pulsing "Loading templates…" line with three skeleton `.lpa-panel`s at card height. Keep the "Loading templates…" text as visually-hidden copy, because a test asserts it.
- Load error: keep the `role="alert"` `.lpa-bad` line, placed directly above the grid.

### 2.4 Stage 2 — configure form
- One `.lpa-panel`. The template name is the panel heading, and the current "you're configuring…" line becomes a `.lp-eyebrow`.
- Every input stays in `.lpa-field` with its `.flabel`. **Do not change label text.** Tests query `daily limit`, `max single transfer — token contract`, `max single transfer — amount`, `allowed token contracts`, `trusted publishers` and `mode` by label.
- Group the optional rules visually:
  - `data-testid="safety-rules"` block: `.lpa-well` with a `.lp-eyebrow` header "Safety rules (optional)". Keep the testid.
  - `data-testid="provenance-mode"` block: same treatment, header "Provenance". Keep the testid.
- Validation errors (`ul role="alert"`) move to a single `.lpa-bad` list directly above the actions row.
- Actions row: primary `LpActionButton` "Validate & generate" and secondary `variant="outline"` "Back". One signal action per view. Keep the button names.

### 2.5 Stage 3 — review & deploy
Rebuild the review card as a **summary first, detail second** layout:

1. **Status line:** "Policy generated" in `.lpa-ok`. The `/policy generated/i` test depends on it.
2. **Summary as `.lpa-detail` rows** (`dt`/`dd`, the same component the dashboard uses): template, daily cap (for example "100 XLM", which is test-asserted), per-tx cap, co-owners/threshold, allowlist count, provenance ("restricted to N trusted publisher(s)", also test-asserted). This replaces the separate prose wells.
3. **Technical detail**, collapsed by default in a `<details>` element: the definition JSON `<pre>` and the manifest hash. Use `.lp-eyebrow` for the labels in place of the inline mono-uppercase spans.
4. **Enforcement note:** one `.lpa-well` explaining what deploys versus what is off-chain only (the existing `deployable` / verified-only copy).
5. **Deploy progress:** the button label keeps showing "Checking…" and then the step text. Add a `.lp-verified`-style pulse dot beside it while `state.name` is `simulating` or `deploying`.
6. **Result states:**
   - *done:* a `.lpa-panel` block with the `.lp-verified` badge "Policy attached to your account", the contract id and attach tx hash in mono (`break-all`), then the existing detach control. `attachhash123` must still render as text.
   - *detached:* the same block shape with a neutral badge "Policy removed" and the removal tx hash.
   - *error:* `role="alert"` `.lpa-bad`, directly above the actions.
7. **Actions:** "Deploy to my account" (primary, only when `deployable`), then "Back"/"Done" (outline).

## 3. Token and class rules (from design.md §7 via app.css)

- No hex values and no raw `var(--lp-…)` colour utilities in the TSX. If a class is missing, add a named one to `components/app.css` in the `.lpa-*` namespace.
- Zero border radius with 45° cut corners (`--lp-clip-*`). No elevation shadows. Use `0.2s ease` for state changes.
- Use the mono font only for addresses, hashes, amounts in base units and JSON.
- Security semantics: `--lpa-ok` for positive/verified and `--lpa-bad` for error. Both are AA-checked on paper.
- Light-only. The `.lpa` transitional remap block in `app.css` must not be relied on. This page should need none of the legacy `--bg`/`--signal` variables once migrated.

New CSS to add to `components/app.css` (proposed):

| Class | Purpose |
| --- | --- |
| `.lpa-pagehead` | eyebrow + h1 + lead stack with system spacing |
| `.lpa-stepper` | display-only step indicator built on `.lp-chips` |
| `.lpa-skeleton` | loading placeholder panel |
| `.lpa-result` | success/removed result block inside a panel |

## 4. Acceptance

- [ ] `page.test.tsx` and `page.flag-gating.test.tsx` pass **unchanged**. All labels, roles, testids and asserted strings are preserved.
- [ ] `grep -E "text-\[var\(--lp-|font-\[family-name" apps/web/app/policies/page.tsx` returns nothing.
- [ ] The rollout-gated state, all three stages and every deploy state (idle, simulating, deploying, done, detaching, detached, error) have been checked at 1280px and at 375px (bottom tab bar, no horizontal scroll).
- [ ] Keyboard: template cards, form fields and actions are reachable in order, and the focus ring comes from `.lp`.
- [ ] Before/after screenshots are attached to the PR.

## 5. Out of scope

- New templates, co-owner UX changes, or any change to the deploy/detach transactions.
- Removing the `.lpa` transitional remap block. That happens once every page has migrated (cleanup, settings and onboarding are still pending).
