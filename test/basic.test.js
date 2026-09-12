const test = require('node:test');
const assert = require('node:assert/strict');

const { isValidBirthDate, normalizePhone, normalizeName, areLikelyNameMatches } = require('../src/domain-utils');

test('validates realistic birthday values', () => {
  assert.equal(isValidBirthDate(31, 2), false);
  assert.equal(isValidBirthDate(29, 2), true);
  assert.equal(isValidBirthDate(1, 12), true);
  assert.equal(isValidBirthDate(0, 6), false);
});

test('normalizes phones for duplicate checks', () => {
  assert.equal(normalizePhone('+233 244 123 456'), '233244123456');
  assert.equal(normalizePhone('(024) 300-1234'), '0243001234');
});

test('handles fuzzy name matching for likely duplicates', () => {
  assert.equal(normalizeName('  Kwadwo  Mensah '), 'kwadwo mensah');
  assert.equal(areLikelyNameMatches('Kwadwo Mensah', 'Kwadwo Mensah'), true);
  assert.equal(areLikelyNameMatches('Kwadwo Mensah', 'Kwame Mensah'), false);
});
