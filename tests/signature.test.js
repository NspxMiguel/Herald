import { test, expect } from 'bun:test';
const signature = require('../src/core/signature.cjs');

test('the marker survives trimEnd, which is the whole point of it', () => {
  const signed = signature.sign('vou chegar tarde');
  expect(signed.trimEnd()).toBe(signed);
  expect(signature.isSigned(signed)).toBe(true);
});

test('what the owner typed himself carries no marker', () => {
  expect(signature.isSigned('escrevi eu mesmo')).toBe(false);
});

test('signing twice does not stack markers', () => {
  const once = signature.sign('oi');
  expect(signature.sign(once)).toBe(once);
});

test('strip gives back the readable text', () => {
  expect(signature.strip(signature.sign('bom dia'))).toBe('bom dia');
});
