// ═══════════════════════════════════════════════════════════════════
// LIVE (REAL-MONEY) TRADING — DISABLED BY DEFAULT
// ═══════════════════════════════════════════════════════════════════
// This module exists ONLY to make the safety boundary visible and auditable.
// Phase 1 of this app is PAPER TRADING ONLY.
//
// Enabling real-money execution requires ALL of:
//   1. Jay's explicit approval (not a default, not a toggle in settings UI),
//   2. a code change setting LIVE_TRADING_ENABLED = true,
//   3. a real broker/exchange execution adapter (does not exist in this repo),
//   4. a full security review (key custody, signing, limits).
//
// Nothing in the app imports these functions except the disabled-status UI.
// Any call throws. Do not "wire this up" without the above.

export const LIVE_TRADING_ENABLED = false;

export function assertLiveDisabled() {
  if (!LIVE_TRADING_ENABLED) {
    throw new Error(
      'LIVE TRADING DISABLED — real-money execution requires Jay\'s explicit ' +
      'approval and a security review. This app trades paper only.'
    );
  }
}

export function executeLiveTrade() { assertLiveDisabled(); }
export function executeLiveCopy() { assertLiveDisabled(); }
export function withdrawRealFunds() { assertLiveDisabled(); }
