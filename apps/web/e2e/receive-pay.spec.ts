import { expect, test, type Page } from "@playwright/test";

// e2e: receive flow + incoming SEP-7 payment requests (issue #402). Fully
// mocked — no backend, no signing — so it runs in CI. Proves the USER flow:
// the receive screen shows the real smart-account C-address with a QR and
// working copy, a valid request prefills the send flow without submitting
// anything, and hostile requests are rejected with nothing prefilled.

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAYEE = "GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO";
const TESTNET = encodeURIComponent("Test SDF Network ; September 2015");

async function seedSession(page: Page) {
  await page.addInitScript((accountId) => {
    window.localStorage.setItem(
      "vellar.session",
      JSON.stringify({
        accountId,
        network: "testnet",
        connected: true,
        authMethod: "passkey",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }),
    );
  }, WALLET);
}

/** Fail loudly if anything tries to submit a transaction. */
async function forbidSubmission(page: Page): Promise<() => boolean> {
  let submitted = false;
  await page.route("**/wallet/submit", async (route) => {
    submitted = true;
    await route.abort();
  });
  return () => submitted;
}

function payUrl(uri: string): string {
  return `/pay?uri=${encodeURIComponent(uri)}`;
}

// @ci — fully mocked (no backend/secrets), safe to run in CI.
test.describe("receive + SEP-7 payment requests @ci", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page);
    // Balances read Soroban RPC; the receive flow doesn't need them.
    await page.route("**/soroban-testnet.stellar.org/**", (route) => route.abort());
  });

  test("receive screen shows the C-address, a QR, and copies the address", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Receive" }).click();

    await expect(page.getByTestId("receive-address")).toHaveText(WALLET);
    const qr = page.getByTestId("receive-qr");
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute(
      "data-qr-payload",
      `web+stellar:pay?destination=${WALLET}&network_passphrase=${TESTNET}`,
    );

    await page.getByLabel(/amount/i).fill("5");
    await expect(qr).toHaveAttribute("data-qr-payload", /amount=5/);

    await page.getByRole("button", { name: /copy address/i }).click();
    await expect(page.getByRole("button", { name: /copied/i })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(WALLET);
  });

  test("a valid request prefills every field and never auto-submits", async ({ page }) => {
    const wasSubmitted = await forbidSubmission(page);
    await page.goto(
      payUrl(
        `web+stellar:pay?destination=${PAYEE}&amount=2.5&msg=coffee&network_passphrase=${TESTNET}`,
      ),
    );

    const to = page.getByLabel(/recipient/i);
    await expect(to).toHaveValue(PAYEE);
    await expect(to).toHaveAttribute("readonly", "");
    await expect(page.getByLabel(/amount/i)).toHaveValue("2.5");
    await expect(page.getByText(/unverified source/i)).toBeVisible();
    await expect(page.getByText(/coffee/)).toBeVisible();
    await expect(page.getByRole("button", { name: /review payment/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /confirm with passkey/i })).toHaveCount(0);

    await page.waitForTimeout(500);
    expect(wasSubmitted()).toBe(false);
  });

  for (const [label, uri, message] of [
    [
      "callback hijack",
      `web+stellar:pay?destination=${PAYEE}&network_passphrase=${TESTNET}&callback=url%3Ahttps%3A%2F%2Fevil.example`,
      /callback/i,
    ],
    [
      "duplicate amount",
      `web+stellar:pay?destination=${PAYEE}&amount=1&amount=999&network_passphrase=${TESTNET}`,
      /ambiguous/i,
    ],
    [
      "script injection in msg",
      `web+stellar:pay?destination=${PAYEE}&msg=%3Cscript%3Ealert(1)%3C%2Fscript%3E%0A&network_passphrase=${TESTNET}`,
      /unsupported characters/i,
    ],
    ["transaction signing request", `web+stellar:tx?xdr=AAAA`, /only payment requests/i],
    [
      "malformed encoding",
      `web+stellar:pay?destination=${PAYEE}&msg=%E0%A4%A&network_passphrase=${TESTNET}`,
      /invalid encoding/i,
    ],
  ] as const) {
    test(`rejects a hostile request: ${label}`, async ({ page }) => {
      const wasSubmitted = await forbidSubmission(page);
      let dialogShown = false;
      page.on("dialog", (d) => {
        dialogShown = true;
        void d.dismiss();
      });
      await page.goto(payUrl(uri));

      // Next's route announcer is also role="alert"; match only the app's.
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText(
        message,
      );
      await expect(page.getByText(/nothing was signed or sent/i)).toBeVisible();
      await expect(page.getByLabel(/recipient/i)).toHaveCount(0);
      expect(dialogShown).toBe(false);
      expect(wasSubmitted()).toBe(false);
    });
  }
});
