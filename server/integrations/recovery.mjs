import { PendingOperation, ReviewRequired, PurchaseRefunded } from './jobs.mjs';

const append = (previous, entry) => [...(Array.isArray(previous?.history) ? previous.history : []), entry].slice(-12);
export function recoveryDue(recovery = {}, now = Date.now()) {
  return !['quarantined', 'refunded', 'confirmed'].includes(recovery.state)
    && (!recovery.nextAttemptAt || recovery.nextAttemptAt <= now);
}
export function beginRecoveryAttempt(previous = {}, now = Date.now()) {
  return { ...previous, state: 'running', attempts: (Number(previous.attempts) || 0) + 1,
    lastAttemptAt: now, nextAttemptAt: null, history: append(previous, { at: now, state: 'running', code: 'attempt_started' }) };
}
export function finishRecoveryAttempt(previous, outcome, now = Date.now()) {
  let state = 'retrying', code = 'provider_unavailable', reason = 'Provider unavailable; the existing operation will be reconciled automatically.';
  let delay = Math.min(300_000, 15_000 * 2 ** Math.min(5, Math.max(0, previous.attempts - 1)));
  if (outcome === 'confirmed') { state = 'confirmed'; code = 'confirmed'; reason = 'Confirmed.'; }
  else if (outcome instanceof PurchaseRefunded) { state = 'refunded'; code = 'refund_verified'; reason = 'Refund verified on-chain; funding capacity restored.'; }
  else if (outcome instanceof ReviewRequired) {
    state = 'quarantined'; code = 'intent_quarantined';
    reason = 'Operation quarantined because its payment, asset, recipient, or settlement evidence could not be safely validated.';
  } else if (outcome instanceof PendingOperation) {
    // Only known internal codes select public text. Upstream error bodies and
    // credential-bearing URLs are never persisted in public diagnostics.
    const messages = {
      confirmation_pending: 'Waiting for confirmation; the same operation will be reconciled automatically.',
      payment_ambiguous: 'Payment evidence is incomplete. Funds remain reserved; no replacement payment will be created.',
      refund_pending: 'Waiting for a confirmed refund to the treasury. No refund credit has been applied.',
      custody_pending: 'Waiting for verified treasury custody of the collectible.',
      eligibility_pending: 'Waiting for the winner to meet the required token holding.',
    };
    code = Object.hasOwn(messages, outcome.code) ? outcome.code : 'confirmation_pending';
    reason = messages[code];
    delay = ['payment_ambiguous', 'refund_pending', 'eligibility_pending'].includes(code) ? 60_000 : 15_000;
  }
  return { ...previous, state, code, reason, nextAttemptAt: state === 'retrying' ? now + delay : null,
    history: append(previous, { at: now, state, code }) };
}
export function recoveryResult(recovery = {}) {
  return { status: recovery.state === 'quarantined' ? 'quarantined' : 'pending', reason: recovery.reason,
    code: recovery.code, attempts: recovery.attempts ?? 0, lastAttemptAt: recovery.lastAttemptAt ?? null,
    nextAttemptAt: recovery.nextAttemptAt ?? null, history: recovery.history ?? [] };
}
