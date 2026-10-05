import test from 'node:test';
import assert from 'node:assert/strict';
import { startupDiagnostic } from '../server/startup-diagnostics.mjs';

test('database authentication failure explains existing-role password mismatch without printing secrets', () => {
  const error = Object.assign(new Error('password SECRET postgres://lootmon:SECRET@private-host/db'), { code: '28P01', detail: 'SECRET' });
  const result = startupDiagnostic(error);
  assert.match(result, /startup:treasury:28P01/);
  assert.match(result, /environment does not rotate/);
  assert.ok(!result.includes('SECRET')); assert.ok(!result.includes('private-host'));
});
test('network causes and aggregate failures produce a safe actionable reason', () => {
  const error = new AggregateError([Object.assign(new Error('secret hostname'), { code: 'ECONNREFUSED' })]);
  assert.match(startupDiagnostic(new Error('secret', { cause: error })), /connection was refused/);
});
test('treasury, public-key, CA and saved-state failures are distinguished', () => {
  assert.match(startupDiagnostic(new Error('This CA belongs to a different treasury wallet. Restore its original treasury key.')), /TREASURY_CHANGED/);
  assert.match(startupDiagnostic(new Error('MEMECOIN_MINT must be a valid Solana public key')), /PUBLIC_KEY_INVALID/);
  assert.match(startupDiagnostic(new SyntaxError('SECRET JSON'), 'world'), /SAVED_JSON_INVALID/);
  assert.match(startupDiagnostic({code:'ENOSPC'}, 'world'), /Storage is full/);
});
test('unknown and cyclic errors never echo arbitrary fields or stack traces', () => {
  const error = Object.assign(new Error('SECRET'), { code: 'SECRET', stack:'SECRET', cause:null }); error.cause=error;
  const result=startupDiagnostic(error,'SECRET');
  assert.match(result,/startup:startup:INITIALIZATION_FAILED/);
  assert.ok(!result.includes('SECRET'));
});

test('CA switch guidance preserves only the validated public mint and fixed instruction', () => {
  const message = 'CA switch blocked: restore MEMECOIN_MINT=11111111111111111111111111111111 and finish its pending payment or award recovery first.';
  assert.match(startupDiagnostic(new Error(message)), /CA_SWITCH_PENDING/);
  const unsafe = startupDiagnostic(new Error(`${message} SECRET`));
  assert.match(unsafe, /INITIALIZATION_FAILED/);
  assert.ok(!unsafe.includes('SECRET'));
});
