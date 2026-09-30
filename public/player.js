'use strict';

const SESSION_STORAGE_KEY = 'kahoot.player.session';
const SCREEN_NAMES = ['join', 'waiting', 'question', 'result', 'closed'];
const OPTION_STYLES = [
  { background: 'bg-red-600', symbol: '▲' },
  { background: 'bg-blue-600', symbol: '◆' },
  { background: 'bg-yellow-500 text-black', symbol: '●' },
  { background: 'bg-green-600', symbol: '■' },
];

const socket = io({ transports: ['websocket'] });
const $ = (id) => document.getElementById(id);

let session = null;
let hasAnsweredCurrentQuestion = false;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
  } catch (error) {
    console.warn('Could not read stored session', error);
    return null;
  }
}

function saveSession(value) {
  try {
    if (value) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (error) {
    console.warn('Could not persist session', error);
  }
}

function generatePlayerId() {
  return crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showScreen(name) {
  for (const screenName of SCREEN_NAMES) $(`screen-${screenName}`).classList.toggle('hidden', screenName !== name);
}

function renderAnswerButtons(options, isLocked) {
  $('answer-buttons').replaceChildren(
    ...options.map((option, index) => {
      const style = OPTION_STYLES[index];
      const button = document.createElement('button');
      button.className = `${style.background} rounded-2xl p-4 min-h-[7rem] text-lg font-bold flex flex-col items-center justify-center gap-1 disabled:opacity-40`;
      button.disabled = isLocked;
      const symbol = document.createElement('span');
      symbol.className = 'text-4xl';
      symbol.textContent = style.symbol;
      const label = document.createElement('span');
      label.textContent = option;
      button.append(symbol, label);
      button.addEventListener('click', () => submitAnswer(index));
      return button;
    }),
  );
}

function renderQuestion(question, remaining, alreadyAnswered = false) {
  hasAnsweredCurrentQuestion = alreadyAnswered;
  $('question-counter').textContent = `${question.index + 1} / ${question.total}`;
  $('question-text').textContent = question.question;
  $('timer-value').textContent = remaining;
  $('answer-status').textContent = alreadyAnswered ? 'Respuesta enviada' : '';
  renderAnswerButtons(question.options, alreadyAnswered);
  showScreen('question');
}

function submitAnswer(choiceIndex) {
  if (hasAnsweredCurrentQuestion) return;
  hasAnsweredCurrentQuestion = true;
  for (const button of $('answer-buttons').children) button.disabled = true;
  $('answer-status').textContent = 'Enviando…';
  socket.emit('player:answer', { choiceIndex }, (response) => {
    $('answer-status').textContent = response.ok ? 'Respuesta enviada' : response.error;
  });
}

function renderResult({ correct, answered, points, score, rank, totalPlayers }, isFinal = false) {
  $('result-title').textContent = correct ? '¡Correcto!' : answered ? 'Incorrecto' : 'Sin respuesta';
  $('result-title').className = `text-5xl font-black ${correct ? 'text-emerald-400' : 'text-red-400'}`;
  $('result-points').textContent = correct ? `+${points} puntos` : '+0 puntos';
  $('result-score').textContent = score;
  $('result-rank').textContent = `Puesto ${rank} de ${totalPlayers}`;
  $('result-footer').textContent = isFinal ? '¡Fin de la partida!' : 'Esperando la siguiente pregunta…';
  showScreen('result');
}

function applySnapshot(snapshot) {
  const self = snapshot.self;
  $('waiting-nickname').textContent = self.nickname;
  switch (snapshot.state) {
    case 'LOBBY':
      return showScreen('waiting');
    case 'QUESTION':
      return renderQuestion(snapshot.question, snapshot.remaining, self.answered);
    case 'SCOREBOARD':
    case 'FINISHED':
      return renderResult(
        { correct: self.correct === true, answered: self.answered, points: self.points, score: self.score, rank: self.rank, totalPlayers: self.totalPlayers },
        snapshot.state === 'FINISHED',
      );
  }
}

function joinRoom(credentials, { isAutomatic }) {
  socket.emit('player:join', credentials, (response) => {
    if (!response.ok) {
      if (isAutomatic) {
        saveSession(null);
        session = null;
        showScreen('join');
      }
      $('join-error').textContent = response.error;
      return;
    }
    session = credentials;
    saveSession(session);
    applySnapshot(response.snapshot);
  });
}

socket.on('connect', () => {
  $('connection-banner').classList.add('hidden');
  const savedSession = loadSession();
  if (savedSession) joinRoom(savedSession, { isAutomatic: true });
  else showScreen('join');
});

socket.on('disconnect', () => $('connection-banner').classList.remove('hidden'));

socket.on('question:start', (question) => renderQuestion(question, question.remaining));
socket.on('timer', ({ remaining }) => {
  $('timer-value').textContent = remaining;
});
socket.on('question:end', () => {
  hasAnsweredCurrentQuestion = true;
  for (const button of $('answer-buttons').children) button.disabled = true;
});
socket.on('player:result', (result) => renderResult(result));
socket.on('game:finished', () => {
  $('result-footer').textContent = '¡Fin de la partida!';
});
socket.on('host:status', ({ connected }) => $('host-banner').classList.toggle('hidden', connected));
socket.on('room:closed', ({ reason }) => {
  saveSession(null);
  session = null;
  $('closed-reason').textContent = reason;
  showScreen('closed');
});

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('join-error').textContent = '';
  joinRoom(
    {
      pin: $('pin-input').value.trim(),
      nickname: $('nickname-input').value.trim(),
      playerId: (session && session.playerId) || generatePlayerId(),
    },
    { isAutomatic: false },
  );
});

$('rejoin').addEventListener('click', () => showScreen('join'));
