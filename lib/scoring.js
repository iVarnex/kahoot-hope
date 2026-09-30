'use strict';

const BASE_POINTS = 1000;

// points = base * (1 - elapsed / (2 * timeLimit)): instant answers earn 1000, last-second ones 500.
function calculatePoints(elapsedSeconds, timeLimitSeconds) {
  const elapsedRatio = Math.min(Math.max(elapsedSeconds / timeLimitSeconds, 0), 1);
  return Math.round(BASE_POINTS * (1 - elapsedRatio / 2));
}

function buildRanking(playersById) {
  return Object.entries(playersById)
    .map(([playerId, player]) => ({
      playerId,
      nickname: player.nickname,
      score: player.score,
      lastPoints: player.lastPoints || 0,
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map((entry, position) => ({ ...entry, rank: position + 1 }));
}

module.exports = { BASE_POINTS, calculatePoints, buildRanking };
