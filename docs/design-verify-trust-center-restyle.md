# Design note — Restyle the verify / trust center page (`/verify`)

**Status:** PROPOSED
**Scope:** visual restyle of `apps/web/app/verify/page.tsx` into a "trust center" in line with design.md §7 ("paper & signals" at product density, `components/app.css`). **No behaviour changes.** The lookup, history, submission, validation and API calls through `@/lib/verification` all stay as they are.
**Tracks:** open-work-catalogue.md item 5.3 ("App pages restyled per design.md §7"). This note covers the verify page only.
**Grounding:** `apps/web/components/app.css`, `apps/web/app/landing/landing.css`, `packages/ui/src/trust-badge.tsx`, and the migrated reference `app/dashboard/page.tsx`.

> design.md is gitignored (`.gitignore:45`), so this note restates the rules it relies on from the committed CSS rather than quoting §7. If §7 disagrees with anything here, §7 wins. Update this note to match.

---

## 1. Where the page is today

| Problem | Where |
| --- | --- |
| The tabs are two `lp-btn` buttons with forest/outline variants. Visually they read as two competing actions, not as a tab set. | `TabButton` |
| The lookup input uses a standalone `.lpa-input` with an inline mono font. The submit form uses `.lpa-field`, so the two tabs are styled inconsistently. | `Explorer` vs `SubmitForm` |
| The verdict is a small `TrustBadge` next to a count line. The most important answer on the page ("is this contract verified?") has the least visual weight. | `Explorer` |
| History records are identical `.lpa-panel`s. The latest verdict is not separated from older attempts. | `RecordCard` |
| Rebuilt hash and deployed hash sit on separate rows, so users cannot see at a glance that they *match*, which is the whole point of the page. | `RecordCard` |
| The source-type radios are unstyled browser radios. | `SubmitForm` |
| Inline Tailwind colour/type utilities (`text-[var(--lp-ink-faint)]`, `font-[family-name:var(--lp-mono)]`) are used throughout. | throughout |

## 2. Target layout

```
┌ AppShell ───────────────────────────────────────────────┐
│  EYEBROW  Trust center                                  │
│  H1       Contract verification                         │
│  lead     We rebuild published source and compare it…   │
│                                                         │
│  [ Check a contract | Submit for verification ]  ← tabs │
│                                                         │
│  Explore tab:                                           │
│   ┌ lookup ───────────────────────── [Check] ┐          │
│   ┌ VERDICT HERO ────────────────────────────┐          │
│   │  ● Verified        badge md              │          │
│   │  C…ABCD  (mono, copy)                    │          │
│   │  Rebuilt  a1b2…  ═  Deployed  a1b2…  ✓   │          │
│   └──────────────────────────────────────────┘          │
│   HISTORY (n attempts)                                  │
│   ├ row · badge sm · source · toolchain · time          │
│   └ row …                                               │
└─────────────────────────────────────────────────────────┘
```

### 2.1 Page header
- `.lp-eyebrow` "Trust center", then `<h1>` "Contract verification", then a `.lp-lead` with the existing explanatory copy, shortened to 2 sentences.
- Add a short "How verification works" `<details>` under the lead with 3 steps (submit source → deterministic rebuild → byte-for-byte hash compare). Collapsed by default.

### 2.2 Tabs
- Replace the button pair with the `.lp-chips` segmented control (same pattern as the dashboard's segmented chips). Keep `role="tablist"`, `role="tab"` and `aria-selected`, and add `aria-controls` / `role="tabpanel"` on the panels.
- Keep the tab names "Check a contract" and "Submit for verification". The tests query the tab by role and name.
- Arrow-key navigation between tabs, following the WAI-ARIA tabs pattern.

### 2.3 Explore tab
**Lookup bar:** one `.lpa-panel` containing a `.lpa-field` (label "Contract address", mono input) and the primary "Check" `LpActionButton` on the same row, wrapping below at mobile width. The label text and the button name "Check" must not change.

**Verdict hero** (new, shown when `records` is loaded):
- A `.lpa-panel` whose left accent follows the tone of the latest status: verified → `--lpa-ok`, failed/mismatch → `--lpa-bad`, pending → sun, unverified → neutral. Add this as a modifier class, not inline style.
- It contains a `TrustBadge size="md"`, the contract id in mono with a copy button, and a **hash comparison row**: `Rebuilt` hash ⟷ `Deployed` hash, each truncated in the middle (`a1b2c3…f9e8`) with the full value in `title` and a copy button. Show a match/mismatch indicator (✓ in `.lpa-ok` / ✕ in `.lpa-bad`) only when both hashes are present.
- The full hashes must still be present in the DOM as text, because a test asserts `"f".repeat(64)`. Truncate visually with CSS (`text-overflow`) or keep the full string in a visually-hidden span.
- Empty state (0 records): use `.lpa-empty` with the "Unverified" badge, the existing copy ("No verification has been submitted for this contract yet.", which is test-asserted), and a secondary link-button "Submit it for verification" that switches to the submit tab and pre-fills the contract id.

**History list:**
- Section label `.lp-eyebrow` "History · N attempts".
- Records become compact rows (using the `.lpa-tokrow` / `.lpa-detail-row` density) instead of full panels: `TrustBadge sm`, source (`repo @ commit7` or "uploaded archive"), toolchain (for example "1.81.0", which is test-asserted), and a relative time with the absolute time in `title`.
- Each row expands (a `<details>` element) to show the full `.lpa-detail` block: source, toolchain, both hashes, and the sanitized `statusDetail` in a `.lpa-well`. **Keep rendering only `statusDetail`.** The raw build log stays hidden (#229, H3/FIX 6).
- The newest record is already shown in the hero, so the list starts expanded on the first row only.

**Errors:** a `role="alert"` `.lpa-bad` line directly under the lookup bar. This adds `role="alert"` to the current `<p>`.

### 2.4 Submit tab
- One `.lpa-panel` with a heading "Submit source for verification" and a `.lp-eyebrow` "Developers".
- Replace the source-type radios with a `.lp-chips` radio group ("Git repository" / "Uploaded archive"). Keep native `<input type="radio">` elements, visually hidden, so it stays keyboard- and form-accessible.
- Two-column grid at ≥760px: repository URL | commit hash, toolchain version | build flags. Single column on mobile.
- Keep all field labels verbatim: "Contract address", "Repository URL", "Commit hash", "Toolchain version", "Build flags (optional, space-separated)".
- Mono font only on the contract address and commit hash inputs.
- Actions: primary "Submit for verification", with the button name unchanged.
- **Success state:** replace the form panel's body with a result block showing a `TrustBadge` (pending), "Submission received" (test-asserted), the queued contract id, and a secondary button "Track status" that switches to the explore tab and runs the lookup. That button replaces the current "check the other tab" sentence.

## 3. TrustBadge

`TrustBadge` (`@vellar/ui`) uses inline pill styling with its own hex palette so that it renders identically in the extension popup. **Do not restyle it in this change.** It is shared with the extension approval screen, and changing it is a cross-surface decision for design.md §8. The page should frame the badge (hero accent, layout) rather than override it. If §7 requires the badge to follow the paper/clip-corner language, raise that as a separate issue against `packages/ui`.

## 4. Token and class rules (from design.md §7 via app.css)

- No hex values and no raw `var(--lp-…)` colour utilities in the TSX. Add named `.lpa-*` classes to `components/app.css` instead.
- Zero radius with 45° cut corners. No elevation shadows. Use `0.2s ease` transitions. Light-only.
- Use the mono font only for addresses, hashes and toolchain strings.

Proposed new classes in `components/app.css`:

| Class | Purpose |
| --- | --- |
| `.lpa-pagehead` | eyebrow + h1 + lead (shared with policies, see design-policies-page-restyle.md) |
| `.lpa-verdict` + `--ok / --bad / --pending / --neutral` | verdict hero panel with tone accent |
| `.lpa-hashcmp` | rebuilt ⟷ deployed hash comparison row |
| `.lpa-hash` | mono, middle-truncated hash with copy affordance |
| `.lpa-history` | compact expandable history rows |

## 5. Acceptance

- [ ] `app/verify/page.test.tsx` passes **unchanged**. Tab/button names, field labels and every asserted string (`Unverified`, `No verification has been submitted`, `1.81.0`, the 64-char hash, `Submission received`, the validation messages) are preserved.
- [ ] `grep -E "text-\[var\(--lp-|font-\[family-name|lp-btn" apps/web/app/verify/page.tsx` returns nothing.
- [ ] Checked at 1280px and 375px: the lookup row wraps, the hash row stacks, and there is no horizontal scroll.
- [ ] Tabs support arrow-key navigation. The verdict hero is announced (the badge already has `role="status"`).
- [ ] Every verdict tone (verified, failed/mismatch, pending, unverified, empty) has been captured in before/after screenshots on the PR.

## 6. Out of scope

- Any change to `TrustBadge`, `@vellar/verification-sdk` or the gateway API.
- Exposing build logs, or any field the public API doesn't return.
- Deep-linking (`/verify?contract=C…`). Worth doing, but it is a behaviour change and should be a follow-up issue.
