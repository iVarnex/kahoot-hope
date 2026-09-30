'use strict';

// Usage: node scripts/loadtest.js <baseUrl> [playerCount]
// Simulates one host and N players playing the whole short game, then checks every player saw every result.
const { io } = require('socket.io-client');

const baseUrl = process.argv[2] || 'http://localhost:3000';
const playerCount = Number(process.argv[3] || 35);
const QUESTION_COUNT = 5;
const CONNECT_TIMEOUT_MS = 20000;

const connect = () =>
  new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });

const emitWithAck = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

async function main() {
  const host = await connect();
  const created = await emitWithAck(host, 'host:create', { mode: 'short' });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  console.log(`room ${created.pin} created`);

  const resultsSeen = new Array(playerCount).fill(0);
  const players = await Promise.all(
    Array.from({ length: playerCount }, async (_unused, index) => {
      const socket = await connect();
      const joined = await emitWithAck(socket, 'player:join', {
        pin: created.pin,
        nickname: `player${index}`,
        playerId: `load-test-player-${index}-xxxxxxxx`,
      });
      if (!joined.ok) throw new Error(`join failed: ${joined.error}`);
      socket.on('question:start', (question) => {
        const choiceIndex = (question.index + index) % 4;
        setTimeout(() => socket.emit('player:answer', { choiceIndex }, () => {}), Math.random() * 1500);
      });
      socket.on('player:result', () => {
        resultsSeen[index] += 1;
      });
      return socket;
    }),
  );
  console.log(`${players.length} players joined`);

  const waitFor = (event) => new Promise((resolve) => host.once(event, resolve));
  for (let question = 0; question < QUESTION_COUNT; question += 1) {
    const ended = waitFor('question:end');
    const started = await emitWithAck(host, question === 0 ? 'host:start' : 'host:next', {});
    if (!started.ok) throw new Error(`advance failed: ${started.error}`);
    await ended;
    console.log(`question ${question + 1} closed`);
  }
  const finished = waitFor('game:finished');
  await emitWithAck(host, 'host:next', {});
  const { ranking } = await finished;
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const expectedResults = QUESTION_COUNT + 1;
  const playersMissingResults = resultsSeen.filter((count) => count !== expectedResults).length;
  console.log(`top: ${ranking.slice(0, 3).map((entry) => `${entry.nickname}=${entry.score}`).join(', ')}`);
  console.log(`players with all ${expectedResults} results: ${playerCount - playersMissingResults}/${playerCount}`);

  for (const socket of [host, ...players]) socket.close();
  process.exit(playersMissingResults === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('LOAD TEST FAILED:', error);
  process.exit(1);
});
