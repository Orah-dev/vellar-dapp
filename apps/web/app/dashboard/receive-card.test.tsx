import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assetsFor } from "@/lib/assets";
import { ReceiveCard } from "./receive-card";

const C_ADDR = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = assetsFor("testnet")[1]!;
const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

function renderCard() {
  render(<ReceiveCard accountId={C_ADDR} network="testnet" onClose={vi.fn()} />);
}

function qrPayload(): string | null {
  return screen.getByTestId("receive-qr").getAttribute("data-qr-payload");
}

describe("ReceiveCard", () => {
  it("shows the smart-account C-address and a QR of a SEP-7 request for it", () => {
    renderCard();
    expect(screen.getByTestId("receive-address").textContent).toBe(C_ADDR);
    expect(qrPayload()).toMatch(new RegExp(`^web\\+stellar:pay\\?destination=${C_ADDR}&`));
    expect(screen.getByTestId("receive-uri").textContent).toBe(qrPayload());
    expect(screen.getByText(/contract addresses/)).toBeDefined();
  });

  it("copies the exact address in one tap", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /copy address/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(C_ADDR));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeDefined();
  });

  it("says so when the clipboard is unavailable", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /copy address/i }));
    expect(await screen.findByRole("button", { name: /copy failed/i })).toBeDefined();
  });

  it("carries a requested registry asset, amount and memo in the request", async () => {
    renderCard();
    fireEvent.change(screen.getByLabelText(/asset/i), { target: { value: USDC.id } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "12.5" } });
    fireEvent.change(screen.getByLabelText(/memo/i), { target: { value: "order 7" } });
    const payload = qrPayload();
    expect(payload).toContain("amount=12.5");
    expect(payload).toContain(`asset_code=USDC&asset_issuer=${USDC.issuer}`);
    expect(payload).toContain("memo=order%207&memo_type=MEMO_TEXT");

    fireEvent.click(screen.getByRole("button", { name: /copy payment link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(payload));
  });

  it("offers only registry assets", () => {
    renderCard();
    const options = Array.from((screen.getByLabelText(/asset/i) as HTMLSelectElement).options).map(
      (o) => o.value,
    );
    expect(options).toEqual(assetsFor("testnet").map((a) => a.id));
  });

  it("refuses an invalid amount instead of encoding it", () => {
    renderCard();
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "1.12345678" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Amount/);
    expect(screen.queryByTestId("receive-qr")).toBeNull();
  });

  it("can encode just the address", () => {
    renderCard();
    fireEvent.click(screen.getByRole("radio", { name: /address only/i }));
    expect(qrPayload()).toBe(C_ADDR);
    expect(screen.queryByTestId("receive-uri")).toBeNull();
  });
});
