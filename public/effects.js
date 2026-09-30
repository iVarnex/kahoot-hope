'use strict';

const CONFETTI_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#22c55e', '#a855f7', '#f97316'];
const CONFETTI_PIECE_COUNT = 90;
const CONFETTI_MIN_SECONDS = 2.5;
const CONFETTI_EXTRA_SECONDS = 2.5;
const CONFETTI_MAX_DELAY_SECONDS = 1.2;

function launchConfetti() {
  const pieces = Array.from({ length: CONFETTI_PIECE_COUNT }, () => {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDuration = `${CONFETTI_MIN_SECONDS + Math.random() * CONFETTI_EXTRA_SECONDS}s`;
    piece.style.animationDelay = `${Math.random() * CONFETTI_MAX_DELAY_SECONDS}s`;
    return piece;
  });
  document.body.append(...pieces);
  const cleanupAfterMs = (CONFETTI_MIN_SECONDS + CONFETTI_EXTRA_SECONDS + CONFETTI_MAX_DELAY_SECONDS) * 1000;
  setTimeout(() => pieces.forEach((piece) => piece.remove()), cleanupAfterMs);
}

// Re-triggers the entrance animation each time a screen is shown.
function animateEntrance(node) {
  node.classList.remove('screen-enter');
  void node.offsetWidth;
  node.classList.add('screen-enter');
}
