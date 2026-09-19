import { test, expect } from 'bun:test';
const rules = require('../src/core/rules.cjs');

const father = { id: 'a', name: 'Pai', phone: '554799999999', mode: 'auto' };
const friend = { id: 'b', name: 'Ana Souza', phone: '554788888888', mode: 'ask' };
const muted = { id: 'c', name: 'Bruno', phone: '554777777777', mode: 'off' };
const people = [father, friend, muted];

test('a name that is not on the list is refused, never guessed', () => {
  const decision = rules.decideSend({ contacts: people, target: 'Carlos', text: 'oi' });
  expect(decision.allowed).toBe(false);
  expect(decision.reason).toBe('not_listed');
});

test('an empty list means nobody is reachable', () => {
  const decision = rules.decideSend({ contacts: [], target: 'Pai', text: 'oi' });
  expect(decision.allowed).toBe(false);
});

test('auto sends immediately, ask waits for the owner', () => {
  expect(rules.decideSend({ contacts: people, target: 'Pai', text: 'oi' }).delivery).toBe('sent');
  expect(rules.decideSend({ contacts: people, target: 'Ana Souza', text: 'oi' }).delivery).toBe(
    'pending'
  );
});

test('a contact set to off is refused even by name', () => {
  const decision = rules.decideSend({ contacts: people, target: 'Bruno', text: 'oi' });
  expect(decision.reason).toBe('muted');
});

test('a partial name resolves only when it is unambiguous', () => {
  expect(rules.resolveTarget(people, 'ana').contact.id).toBe('b');
  const two = [friend, { ...friend, id: 'd', name: 'Ana Lima' }];
  expect(rules.resolveTarget(two, 'ana').error).toBe('ambiguous');
});

test('a mode that was never set is ask, not auto', () => {
  const stranger = [{ id: 'e', name: 'Novo', phone: '554766666666' }];
  expect(rules.decideSend({ contacts: stranger, target: 'Novo', text: 'oi' }).delivery).toBe(
    'pending'
  );
});

test('groups are never a destination', () => {
  const group = [{ id: 'g', name: 'Família', phone: '554755555555', mode: 'auto', isGroup: true }];
  expect(rules.decideSend({ contacts: group, target: 'Família', text: 'oi' }).reason).toBe('group');
});

test('the rate limit applies to auto contacts too', () => {
  const now = Date.now();
  const log = { 554799999999: Array.from({ length: rules.RATE_MAX_PER_WINDOW }, () => now) };
  const decision = rules.decideSend({ contacts: people, target: 'Pai', text: 'oi', log, now });
  expect(decision.reason).toBe('rate_limited');
});

test('a stale rate log does not block a new message', () => {
  const now = Date.now();
  const log = { 554799999999: [now - rules.RATE_WINDOW_MS - 1000] };
  expect(rules.decideSend({ contacts: people, target: 'Pai', text: 'oi', log, now }).allowed).toBe(
    true
  );
});

test('an empty message never reaches WhatsApp', () => {
  expect(rules.decideSend({ contacts: people, target: 'Pai', text: '   ' }).reason).toBe(
    'empty_message'
  );
});

test('a phone number reaches a listed contact, and only a listed one', () => {
  expect(rules.resolveTarget(people, '+55 47 9999-9999').contact.id).toBe('a');
  expect(rules.resolveTarget(people, '5511911112222').error).toBe('not_listed');
});

test('the global ask mode makes even an auto contact wait', () => {
  const decision = rules.decideSend({ contacts: people, target: 'Pai', text: 'oi', gate: 'ask' });
  expect(decision.allowed).toBe(true);
  expect(decision.delivery).toBe('pending');
});

test('ask mode still refuses a contact set to off', () => {
  expect(
    rules.decideSend({ contacts: people, target: 'Bruno', text: 'oi', gate: 'ask' }).reason
  ).toBe('muted');
});

test('ask mode accepts a contact resolved outside the list, always queued', () => {
  const guest = { id: 'book:554766665555', name: 'Vizinho', phone: '554766665555', mode: 'ask' };
  const decision = rules.decideSend({
    contacts: people,
    target: 'Vizinho',
    text: 'oi',
    gate: 'ask',
    contact: guest
  });
  expect(decision.delivery).toBe('pending');
});

test('a guest is refused in list mode, which is what the list is for', () => {
  const decision = rules.decideSend({ contacts: people, target: 'Vizinho', text: 'oi' });
  expect(decision.reason).toBe('not_listed');
});

test('an unknown gate falls back to list, never to the permissive one', () => {
  expect(rules.normalizeGate('open')).toBe('list');
  expect(rules.normalizeGate(undefined)).toBe('list');
  expect(rules.normalizeGate('ASK')).toBe('ask');
});

test('the rate limit still applies in ask mode', () => {
  const now = Date.now();
  const log = { 554799999999: Array.from({ length: rules.RATE_MAX_PER_WINDOW }, () => now) };
  expect(
    rules.decideSend({ contacts: people, target: 'Pai', text: 'oi', gate: 'ask', log, now }).reason
  ).toBe('rate_limited');
});

test('groups are refused in ask mode too', () => {
  const guest = { id: 'g', name: 'Família', phone: '554755555555', mode: 'ask', isGroup: true };
  expect(
    rules.decideSend({
      contacts: people,
      target: 'Família',
      text: 'oi',
      gate: 'ask',
      contact: guest
    }).reason
  ).toBe('group');
});
