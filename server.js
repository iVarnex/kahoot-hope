'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { createStore } = require('./lib/store');
const { getQuestions, QUESTION_MODES } = require('./lib/questions');
const { calculatePoints, buildRanking } = require('./lib/scoring');

const PORT = process.env.PORT || 3000;
const PIN_LENGTH = 6;
const PIN_ATTEMPTS = 20;
const MAX_PLAYERS = 150;
const NICKNAME_MAX_LENGTH = 20;
const ANSWER_GRACE_MS = 1000;
const HOST_RECONNECT_GRACE_MS = 60 * 1000;
const TIMER_TICK_MS = 1000;
const RANKING_SIZE = 10;
const PODIUM_SIZE = 3;
const MAX_SOCKET_PAYLOAD_BYTES = 10 * 1024;

const STATES = { LOBBY: 'LOBBY', QUESTION: 'QUESTION', SCOREBOARD: 'SCOREBOARD', FINISHED: 'FINISHED' };

const app = express();
const server = http.createServer(app);
const { store, publisher, subscriber } = createStore();

const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  transports: ['websocket'],
});
if (publisher && subscriber) {
  const { createAdapter } = require('@socket.io/redis-adapter');
  io.adapter(createAdapter(publisher, subscriber));
}

const PUBLIC_DIRECTORY = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIRECTORY));
app.get('/host', (_request, response) => response.sendFile(path.join(PUBLIC_DIRECTORY, 'host.html')));
app.get('/healthz', (_request, response) => response.json({ ok: true }));

// Timers are per-instance; they read authoritative state from the store on every tick,
// so a reconnecting host can restart the loop on whichever instance it lands on.
const questionTimers = new Map();
const pendingRoomDissolves = new Map();

class UserError extends Error {}

function handle(socket, eventName, handler) {
  socket.on(eventName, async (payload, acknowledge) => {
    if (typeof payload === 'function') {
      acknowledge = payload;
      payload = {};
    }
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    try {
      await handler(payload && typeof payload === 'object' ? payload : {}, reply);
    } catch (error) {
      if (error instanceof UserError) return reply({ ok: false, error: error.message });
      console.error(`[${eventName}]`, error);
      reply({ ok: false, error: 'Error interno del servidor' });
    }
  });
}

function sanitizeNickname(rawNickname) {
  if (typeof rawNickname !== 'string') return '';
  return rawNickname.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NICKNAME_MAX_LENGTH);
}

function isValidPin(pin) {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

function isValidPlayerId(playerId) {
  return typeof playerId === 'string' && /^[\w-]{8,64}$/.test(playerId);
}

function toPublicQuestion(question, index, total) {
  return {
    index,
    total,
    question: question.question,
    options: question.options,
    timeLimit: question.timeLimit,
  };
}

function computeRemainingSeconds(meta, question) {
  const remainingMs = question.timeLimit * 1000 - (Date.now() - meta.questionStartedAt);
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

function countAnswersPerOption(players, optionCount) {
  const counts = new Array(optionCount).fill(0);
  for (const player of Object.values(players)) {
    if (Number.isInteger(player.choice)) counts[player.choice] += 1;
  }
  return counts;
}

function connectedPlayers(players) {
  return Object.values(players).filter((player) => player.connected);
}

async function createRoomWithUniquePin(buildMeta) {
  for (let attempt = 0; attempt < PIN_ATTEMPTS; attempt += 1) {
    const pin = String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
    const meta = buildMeta(pin);
    if (await store.createRoom(pin, meta)) return meta;
  }
  throw new Error('Could not allocate a unique PIN');
}

async function buildSnapshot(meta, players, viewerPlayerId) {
  const questions = getQuestions(meta.mode);
  const ranking = buildRanking(players);
  const snapshot = {
    state: meta.state,
    pin: meta.pin,
    totalQuestions: questions.length,
    playerCount: Object.keys(players).length,
    players: Object.values(players).map((player) => player.nickname),
  };

  const question = questions[meta.currentQuestionIndex];
  if (question) {
    snapshot.question = toPublicQuestion(question, meta.currentQuestionIndex, questions.length);
    snapshot.isLastQuestion = meta.currentQuestionIndex === questions.length - 1;
  }
  if (meta.state === STATES.QUESTION) {
    snapshot.remaining = computeRemainingSeconds(meta, question);
    const connected = connectedPlayers(players);
    snapshot.answeredCount = connected.filter((player) => player.answered).length;
    snapshot.connectedCount = connected.length;
  }
  if (meta.state === STATES.SCOREBOARD || meta.state === STATES.FINISHED) {
    snapshot.correctIndex = question.correctIndex;
    snapshot.answerCounts = countAnswersPerOption(players, question.options.length);
    snapshot.ranking = ranking.slice(0, RANKING_SIZE);
  }

  const viewer = viewerPlayerId && players[viewerPlayerId];
  if (viewer) {
    snapshot.self = {
      nickname: viewer.nickname,
      score: viewer.score,
      answered: viewer.answered,
      correct: viewer.lastCorrect,
      points: viewer.lastPoints,
      rank: ranking.find((entry) => entry.playerId === viewerPlayerId).rank,
      totalPlayers: ranking.length,
    };
  }
  return snapshot;
}

async function notifyHostOfLobby(meta) {
  const players = await store.getPlayers(meta.pin);
  io.to(meta.hostSocketId).emit('lobby:update', {
    players: Object.values(players).map((player) => player.nickname),
  });
}

async function notifyHostOfProgress(meta, players) {
  const connected = connectedPlayers(players);
  io.to(meta.hostSocketId).emit('answers:progress', {
    answered: connected.filter((player) => player.answered).length,
    total: connected.length,
  });
}

function stopQuestionTimer(pin) {
  clearInterval(questionTimers.get(pin));
  questionTimers.delete(pin);
}

function startQuestionTimer(pin, questionIndex) {
  stopQuestionTimer(pin);
  const tick = async () => {
    try {
      const meta = await store.getRoom(pin);
      const isStale = !meta || meta.state !== STATES.QUESTION || meta.currentQuestionIndex !== questionIndex;
      if (isStale) return stopQuestionTimer(pin);

      const question = getQuestions(meta.mode)[questionIndex];
      const remaining = computeRemainingSeconds(meta, question);
      io.to(pin).emit('timer', { remaining });
      if (remaining <= 0) {
        stopQuestionTimer(pin);
        await endQuestion(pin, questionIndex);
      }
    } catch (error) {
      console.error('[timer]', error);
    }
  };
  questionTimers.set(pin, setInterval(tick, TIMER_TICK_MS));
}

async function startQuestion(pin, questionIndex) {
  const meta = await store.getRoom(pin);
  const questions = getQuestions(meta.mode);
  const players = await store.getPlayers(pin);

  await Promise.all(
    Object.entries(players).map(([playerId, player]) =>
      store.savePlayer(pin, playerId, { ...player, answered: false, choice: null, lastPoints: 0, lastCorrect: null }),
    ),
  );

  meta.state = STATES.QUESTION;
  meta.currentQuestionIndex = questionIndex;
  meta.questionStartedAt = Date.now();
  await store.saveRoom(pin, meta);

  const question = questions[questionIndex];
  io.to(pin).emit('question:start', {
    ...toPublicQuestion(question, questionIndex, questions.length),
    remaining: question.timeLimit,
  });
  startQuestionTimer(pin, questionIndex);
}

// Called from the timer and from answer handlers on any instance; the claim makes it run once.
async function endQuestion(pin, questionIndex) {
  const isFirstCaller = await store.claimOnce(`closed:${pin}:${questionIndex}`);
  if (!isFirstCaller) return;

  const meta = await store.getRoom(pin);
  if (!meta || meta.state !== STATES.QUESTION || meta.currentQuestionIndex !== questionIndex) return;

  meta.state = STATES.SCOREBOARD;
  await store.saveRoom(pin, meta);
  stopQuestionTimer(pin);

  const players = await store.getPlayers(pin);
  const question = getQuestions(meta.mode)[questionIndex];
  const ranking = buildRanking(players);

  io.to(pin).emit('question:end', {
    correctIndex: question.correctIndex,
    answerCounts: countAnswersPerOption(players, question.options.length),
    ranking: ranking.slice(0, RANKING_SIZE),
    isLastQuestion: questionIndex === getQuestions(meta.mode).length - 1,
  });
  emitPlayerResults(players, ranking);
}

function emitPlayerResults(players, ranking) {
  for (const [playerId, player] of Object.entries(players)) {
    if (!player.connected) continue;
    io.to(player.socketId).emit('player:result', {
      correct: player.lastCorrect === true,
      answered: player.answered,
      points: player.lastPoints,
      score: player.score,
      rank: ranking.find((entry) => entry.playerId === playerId).rank,
      totalPlayers: ranking.length,
    });
  }
}

async function finishGame(pin) {
  const meta = await store.getRoom(pin);
  meta.state = STATES.FINISHED;
  await store.saveRoom(pin, meta);

  const players = await store.getPlayers(pin);
  const ranking = buildRanking(players);
  io.to(pin).emit('game:finished', { ranking: ranking.slice(0, RANKING_SIZE) });
  emitPlayerFinals(players, ranking);
}

function emitPlayerFinals(players, ranking) {
  for (const [playerId, player] of Object.entries(players)) {
    if (!player.connected) continue;
    io.to(player.socketId).emit('player:final', {
      score: player.score,
      rank: ranking.find((entry) => entry.playerId === playerId).rank,
      totalPlayers: ranking.length,
      podium: ranking.slice(0, PODIUM_SIZE),
    });
  }
}

async function endQuestionIfEveryoneAnswered(meta) {
  const players = await store.getPlayers(meta.pin);
  await notifyHostOfProgress(meta, players);
  const connected = connectedPlayers(players);
  const everyoneAnswered = connected.length > 0 && connected.every((player) => player.answered);
  if (everyoneAnswered) await endQuestion(meta.pin, meta.currentQuestionIndex);
}

async function dissolveRoom(pin, reason) {
  stopQuestionTimer(pin);
  io.to(pin).emit('room:closed', { reason });
  io.in(pin).socketsLeave(pin);
  await store.deleteRoom(pin);
}

async function requireHostRoom(socket) {
  const meta = socket.data.pin ? await store.getRoom(socket.data.pin) : null;
  if (!meta || meta.hostSocketId !== socket.id) throw new UserError('No eres el anfitrión de una sala activa');
  return meta;
}

async function scheduleRoomDissolve(pin, departedSocketId) {
  const meta = await store.getRoom(pin);
  if (!meta || meta.hostSocketId !== departedSocketId) return;

  io.to(pin).emit('host:status', { connected: false });
  clearTimeout(pendingRoomDissolves.get(pin));
  pendingRoomDissolves.set(
    pin,
    setTimeout(async () => {
      pendingRoomDissolves.delete(pin);
      try {
        const latestMeta = await store.getRoom(pin);
        const hostNeverReturned = latestMeta && latestMeta.hostSocketId === departedSocketId;
        if (hostNeverReturned) await dissolveRoom(pin, 'El anfitrión se desconectó');
      } catch (error) {
        console.error('[dissolve]', error);
      }
    }, HOST_RECONNECT_GRACE_MS),
  );
}

async function handlePlayerDisconnect(pin, playerId, socketId) {
  const meta = await store.getRoom(pin);
  const player = meta && (await store.getPlayer(pin, playerId));
  if (!player || player.socketId !== socketId) return;

  if (meta.state === STATES.LOBBY) {
    await store.removePlayer(pin, playerId);
    return notifyHostOfLobby(meta);
  }
  await store.savePlayer(pin, playerId, { ...player, connected: false });
  if (meta.state === STATES.QUESTION) await endQuestionIfEveryoneAnswered(meta);
}

io.on('connection', (socket) => {
  socket.data = {};

  handle(socket, 'host:create', async ({ mode }, reply) => {
    const questionMode = QUESTION_MODES.includes(mode) ? mode : 'full';
    const hostKey = crypto.randomUUID();
    const meta = await createRoomWithUniquePin((pin) => ({
      pin,
      hostSocketId: socket.id,
      hostKey,
      mode: questionMode,
      state: STATES.LOBBY,
      currentQuestionIndex: -1,
      questionStartedAt: null,
    }));
    socket.data = { role: 'host', pin: meta.pin };
    await socket.join(meta.pin);
    reply({ ok: true, pin: meta.pin, hostKey, totalQuestions: getQuestions(questionMode).length });
  });

  handle(socket, 'host:reclaim', async ({ pin, hostKey }, reply) => {
    const meta = isValidPin(pin) ? await store.getRoom(pin) : null;
    if (!meta || meta.hostKey !== hostKey) throw new UserError('La sala ya no existe');

    meta.hostSocketId = socket.id;
    await store.saveRoom(pin, meta);
    clearTimeout(pendingRoomDissolves.get(pin));
    pendingRoomDissolves.delete(pin);

    socket.data = { role: 'host', pin };
    await socket.join(pin);
    io.to(pin).emit('host:status', { connected: true });
    if (meta.state === STATES.QUESTION) startQuestionTimer(pin, meta.currentQuestionIndex);

    const players = await store.getPlayers(pin);
    reply({ ok: true, snapshot: await buildSnapshot(meta, players) });
  });

  handle(socket, 'host:start', async (_payload, reply) => {
    const meta = await requireHostRoom(socket);
    if (meta.state !== STATES.LOBBY) throw new UserError('La partida ya comenzó');
    const players = await store.getPlayers(meta.pin);
    if (Object.keys(players).length === 0) throw new UserError('Necesitas al menos un jugador');
    await startQuestion(meta.pin, 0);
    reply({ ok: true });
  });

  handle(socket, 'host:next', async (_payload, reply) => {
    const meta = await requireHostRoom(socket);
    if (meta.state !== STATES.SCOREBOARD) throw new UserError('Aún no se puede avanzar');
    const isLastQuestion = meta.currentQuestionIndex === getQuestions(meta.mode).length - 1;
    if (isLastQuestion) await finishGame(meta.pin);
    else await startQuestion(meta.pin, meta.currentQuestionIndex + 1);
    reply({ ok: true });
  });

  handle(socket, 'player:join', async ({ pin, nickname, playerId }, reply) => {
    const cleanNickname = sanitizeNickname(nickname);
    if (!isValidPin(pin)) throw new UserError('El PIN debe tener 6 dígitos');
    if (!cleanNickname) throw new UserError('Escribe un apodo');
    if (!isValidPlayerId(playerId)) throw new UserError('Identificador de jugador inválido');

    const meta = await store.getRoom(pin);
    if (!meta) throw new UserError('PIN no válido: no hay ninguna sala activa con ese PIN');

    const players = await store.getPlayers(pin);
    const existingPlayer = players[playerId];
    if (!existingPlayer) {
      if (meta.state !== STATES.LOBBY) throw new UserError('La partida ya comenzó');
      if (Object.keys(players).length >= MAX_PLAYERS) throw new UserError('La sala está llena');
    }
    const nicknameTaken = Object.entries(players).some(
      ([otherId, other]) => otherId !== playerId && other.nickname.toLowerCase() === cleanNickname.toLowerCase(),
    );
    if (nicknameTaken) throw new UserError('Ese apodo ya está en uso');

    const player = {
      score: 0,
      answered: false,
      choice: null,
      lastPoints: 0,
      lastCorrect: null,
      ...existingPlayer,
      nickname: cleanNickname,
      socketId: socket.id,
      connected: true,
    };
    await store.savePlayer(pin, playerId, player);
    socket.data = { role: 'player', pin, playerId };
    await socket.join(pin);

    if (meta.state === STATES.LOBBY) await notifyHostOfLobby(meta);
    const latestPlayers = { ...players, [playerId]: player };
    reply({ ok: true, snapshot: await buildSnapshot(meta, latestPlayers, playerId) });
    if (meta.state === STATES.QUESTION) await endQuestionIfEveryoneAnswered(meta);
  });

  handle(socket, 'player:answer', async ({ choiceIndex }, reply) => {
    const { pin, playerId } = socket.data;
    const meta = pin ? await store.getRoom(pin) : null;
    if (!meta || meta.state !== STATES.QUESTION) throw new UserError('La pregunta ya cerró');

    const question = getQuestions(meta.mode)[meta.currentQuestionIndex];
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= question.options.length) {
      throw new UserError('Opción inválida');
    }

    const elapsedMs = Date.now() - meta.questionStartedAt;
    if (elapsedMs > question.timeLimit * 1000 + ANSWER_GRACE_MS) {
      await endQuestion(pin, meta.currentQuestionIndex);
      throw new UserError('Se acabó el tiempo');
    }

    const player = await store.getPlayer(pin, playerId);
    if (!player) throw new UserError('No estás en esta sala');
    const isFirstAnswer = await store.claimOnce(`answer:${pin}:${meta.currentQuestionIndex}:${playerId}`);
    if (!isFirstAnswer) throw new UserError('Ya respondiste esta pregunta');

    const isCorrect = choiceIndex === question.correctIndex;
    const points = isCorrect ? calculatePoints(elapsedMs / 1000, question.timeLimit) : 0;
    await store.savePlayer(pin, playerId, {
      ...player,
      answered: true,
      choice: choiceIndex,
      lastCorrect: isCorrect,
      lastPoints: points,
      score: player.score + points,
    });
    reply({ ok: true });
    await endQuestionIfEveryoneAnswered(meta);
  });

  socket.on('disconnect', async () => {
    const { role, pin, playerId } = socket.data;
    try {
      if (role === 'host') await scheduleRoomDissolve(pin, socket.id);
      if (role === 'player') await handlePlayerDisconnect(pin, playerId, socket.id);
    } catch (error) {
      console.error('[disconnect]', error);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Kahoot server listening on http://localhost:${PORT}`));
}

module.exports = server;
