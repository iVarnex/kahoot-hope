'use strict';

const SESSION_STORAGE_KEY = 'kahoot.host.session';
const SCREEN_NAMES = ['create', 'lobby', 'question', 'results', 'final'];
const OPTION_STYLES = [
  { background: 'bg-red-600', symbol: '▲' },
  { background: 'bg-blue-600', symbol: '◆' },
  { background: 'bg-yellow-500 text-black', symbol: '●' },
  { background: 'bg-green-600', symbol: '■' },
];
const PODIUM_HEIGHTS = ['h-56', 'h-40', 'h-28'];
const PODIUM_ORDER = [1, 0, 2];

const socket = io({ transports: ['websocket'] });
const $ = (id) => document.getElementById(id);

let session = null;
let currentQuestion = null;
let currentTimeLimit = 1;

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY));
  } catch (error) {
    console.warn('Could not read stored session', error);
    return null;
  }
}

function saveSession(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (error) {
    console.warn('Could not persist session', error);
  }
}

function showScreen(name) {
  for (const screenName of SCREEN_NAMES) $(`screen-${screenName}`).classList.toggle('hidden', screenName !== name);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLobby(pin, players) {
  $('lobby-pin').textContent = pin;
  $('join-url').textContent = location.host;
  updateLobbyPlayers(players);
  showScreen('lobby');
}

function updateLobbyPlayers(players) {
  $('lobby-count').textContent = players.length;
  $('start-game').disabled = players.length === 0;
  $('lobby-players').replaceChildren(
    ...players.map((nickname) => element('li', 'rounded-full bg-indigo-800 px-4 py-2 text-lg font-semibold', nickname)),
  );
}

function optionCard(option, index, extraClass = '') {
  const style = OPTION_STYLES[index];
  const card = element('div', `flex items-center gap-4 rounded-2xl p-5 text-2xl font-bold ${style.background} ${extraClass}`);
  card.append(element('span', 'text-4xl', style.symbol), element('span', 'flex-1', option));
  return card;
}

function renderQuestion(question, remaining, answered = 0, total = 0) {
  currentQuestion = question;
  currentTimeLimit = question.timeLimit;
  $('question-counter').textContent = `Pregunta ${question.index + 1} de ${question.total}`;
  $('question-text').textContent = question.question;
  $('question-options').replaceChildren(...question.options.map((option, index) => optionCard(option, index)));
  updateAnswerProgress(answered, total);
  updateTimer(remaining);
  showScreen('question');
}

function updateAnswerProgress(answered, total) {
  $('answer-progress').textContent = `${answered} / ${total} respondieron`;
}

function updateTimer(remaining) {
  $('timer-value').textContent = remaining;
  $('timer-bar').style.width = `${Math.max(0, (remaining / currentTimeLimit) * 100)}%`;
}

function renderRanking(listElement, ranking) {
  const topScore = Math.max(1, ...ranking.map((entry) => entry.score));
  listElement.replaceChildren(
    ...ranking.map((entry) => {
      const row = element('li', 'relative overflow-hidden rounded-xl bg-indigo-900 px-4 py-3 flex justify-between text-xl font-semibold');
      const bar = element('div', 'absolute inset-y-0 left-0 bg-indigo-600/60');
      bar.style.width = `${(entry.score / topScore) * 100}%`;
      const name = element('span', 'relative', `${entry.rank}. ${entry.nickname}`);
      const score = element('span', 'relative', `${entry.score}${entry.lastPoints ? `  (+${entry.lastPoints})` : ''}`);
      row.append(bar, name, score);
      return row;
    }),
  );
}

function renderResults({ correctIndex, answerCounts, ranking, isLastQuestion }) {
  $('results-question').textContent = currentQuestion.question;
  $('results-options').replaceChildren(
    ...currentQuestion.options.map((option, index) => {
      const isCorrect = index === correctIndex;
      const card = optionCard(option, index, isCorrect ? 'ring-8 ring-white' : 'opacity-40');
      card.append(element('span', 'text-3xl', `${isCorrect ? '✓ ' : ''}${answerCounts[index]}`));
      return card;
    }),
  );
  renderRanking($('results-ranking'), ranking);
  $('next-question').textContent = isLastQuestion ? 'Finalizar' : 'Siguiente Pregunta';
  showScreen('results');
}

function renderFinal(ranking) {
  $('podium').replaceChildren(
    ...PODIUM_ORDER.filter((position) => ranking[position]).map((position) => {
      const entry = ranking[position];
      const column = element('div', 'flex flex-col items-center gap-2');
      const block = element('div', `w-40 ${PODIUM_HEIGHTS[position]} rounded-t-2xl bg-amber-400 text-black flex items-center justify-center text-5xl font-black`, position + 1);
      column.append(element('p', 'text-xl font-bold', entry.nickname), element('p', 'text-indigo-200', `${entry.score} pts`), block);
      return column;
    }),
  );
  renderRanking($('final-ranking'), ranking);
  showScreen('final');
}

function applySnapshot(snapshot) {
  currentQuestion = snapshot.question || null;
  if (snapshot.question) currentTimeLimit = snapshot.question.timeLimit;
  switch (snapshot.state) {
    case 'LOBBY':
      return renderLobby(snapshot.pin, snapshot.players);
    case 'QUESTION':
      return renderQuestion(snapshot.question, snapshot.remaining, snapshot.answeredCount, snapshot.connectedCount);
    case 'SCOREBOARD':
      return renderResults(snapshot);
    case 'FINISHED':
      return renderFinal(snapshot.ranking);
  }
}

function resetToCreateScreen() {
  session = null;
  saveSession(null);
  showScreen('create');
}

function reclaimSession(savedSession) {
  socket.emit('host:reclaim', savedSession, (response) => {
    if (!response.ok) return resetToCreateScreen();
    session = savedSession;
    applySnapshot(response.snapshot);
  });
}

socket.on('connect', () => {
  $('connection-banner').classList.add('hidden');
  const savedSession = loadSession();
  if (savedSession) reclaimSession(savedSession);
  else showScreen('create');
});

socket.on('disconnect', () => $('connection-banner').classList.remove('hidden'));

socket.on('lobby:update', ({ players }) => updateLobbyPlayers(players));
socket.on('answers:progress', ({ answered, total }) => updateAnswerProgress(answered, total));
socket.on('timer', ({ remaining }) => updateTimer(remaining));
socket.on('question:start', (question) => renderQuestion(question, question.remaining));
socket.on('question:end', renderResults);
socket.on('game:finished', ({ ranking }) => renderFinal(ranking));
socket.on('room:closed', resetToCreateScreen);

$('create-room').addEventListener('click', () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  socket.emit('host:create', { mode }, (response) => {
    if (!response.ok) {
      $('create-error').textContent = response.error;
      return;
    }
    session = { pin: response.pin, hostKey: response.hostKey };
    saveSession(session);
    renderLobby(response.pin, []);
  });
});

$('start-game').addEventListener('click', () => {
  socket.emit('host:start', {}, (response) => {
    if (!response.ok) $('lobby-error').textContent = response.error;
  });
});

$('next-question').addEventListener('click', () => socket.emit('host:next', {}, () => {}));
$('new-game').addEventListener('click', resetToCreateScreen);
