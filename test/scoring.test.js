'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePoints, buildRanking } = require('../lib/scoring');

test('instant answers earn the full 1000 points', () => {
  assert.equal(calculatePoints(0, 20), 1000);
});

test('answering at the time limit earns half the points', () => {
  assert.equal(calculatePoints(20, 20), 500);
});

test('elapsed time beyond the limit never drops below half', () => {
  assert.equal(calculatePoints(99, 20), 500);
});

test('ranking sorts by score descending and assigns ranks', () => {
  const ranking = buildRanking({
    a: { nickname: 'Ana', score: 500 },
    b: { nickname: 'Beto', score: 900 },
  });
  assert.deepEqual(ranking.map((entry) => [entry.nickname, entry.rank]), [['Beto', 1], ['Ana', 2]]);
});
