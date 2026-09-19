import { test, expect } from 'bun:test';
const signature = require('../src/core/signature.cjs');

test('the invisible marker survives trimEnd, which is the whole point of it', () => {
  const signed = signature.sign('vou chegar tarde', 'assistente de IA');
  expect(signed.trimEnd()).toBe(signed);
  expect(signature.isSigned(signed)).toBe(true);
});

test('what the owner typed himself carries no marker', () => {
  expect(signature.isSigned('escrevi eu mesmo')).toBe(false);
});

test('every message says out loud that it came from an assistant', () => {
  const signed = signature.sign('consegue abrir a porta?', 'IA do Miguel');
  expect(signed).toContain('\n— IA do Miguel');
});

test('an empty label falls back to a real one — the line is never absent', () => {
  for (const attempt of ['', '   ', null, undefined]) {
    expect(signature.sign('oi', attempt)).toMatch(/\n— \S/);
  }
});

test('the owner writes the wording, with or without the dash', () => {
  expect(signature.normalizeLabel('— IA do Miguel')).toBe('IA do Miguel');
  expect(signature.normalizeLabel('  assistente   de IA ')).toBe('assistente de IA');
});

test('a label cannot be long enough to become the message', () => {
  expect(signature.normalizeLabel('x'.repeat(200)).length).toBe(signature.MAX_LABEL_LENGTH);
});

test('the default follows the system language', () => {
  expect(signature.defaultLabel('pt_BR.UTF-8')).toBe(signature.DEFAULT_LABELS.pt);
  expect(signature.defaultLabel('en_US.UTF-8')).toBe(signature.DEFAULT_LABELS.en);
});

test('signing twice does not stack markers or labels', () => {
  const once = signature.sign('oi', 'IA');
  expect(signature.sign(signature.readable(once), 'IA')).toBe(once);
});

test('reading back drops the label the agent wrote, not the message', () => {
  const signed = signature.sign('a resposta é 8793', 'assistente de IA');
  expect(signature.readable(signed)).toBe('a resposta é 8793');
});

test('reading back never eats a line the other person wrote', () => {
  const theirs = 'pode ser amanhã\n— mandei pelo celular';
  expect(signature.strip(theirs)).toBe(theirs);
});
