'use strict';

const DEFAULT_TIME_LIMIT_SECONDS = 15;

const HOPE_QUESTIONS = [
  {
    question: 'We use "hope" for desires that are…',
    options: ['Impossible or imaginary', 'Regretted from the past', 'Realistic and attainable', 'Always about ourselves'],
    correctIndex: 2,
    timeLimit: 20,
  },
  {
    question: 'Complete: "I hope ____ medicine next year."',
    options: ['study', 'to study', 'studying', 'that study'],
    correctIndex: 1,
    timeLimit: 20,
  },
  {
    question: 'Choose the correct negative: "She hopes ____ late."',
    options: ["to don't arrive", 'not to arrive', "don't to arrive", "to doesn't arrive"],
    correctIndex: 1,
    timeLimit: 20,
  },
  {
    question: 'Which sentence is correct?',
    options: [
      'We hope to the DJ plays good music.',
      'We hope that the DJ plays good music.',
      'We hope the DJ to play good music.',
      'We hope playing the DJ good music.',
    ],
    correctIndex: 1,
    timeLimit: 20,
  },
  {
    question: '"I hope (that) she has a safe flight." What happens if we remove "that"?',
    options: [
      'The meaning changes to the past',
      'The sentence becomes incorrect',
      'It becomes a wish',
      'Nothing, the meaning is the same',
    ],
    correctIndex: 3,
    timeLimit: 20,
  },
  {
    question: 'Which sentence sounds natural in English?',
    options: ["I don't hope it rains.", "I hope it doesn't rain.", "I hope to don't rain.", 'I not hope it rains.'],
    correctIndex: 1,
    timeLimit: 20,
  },
  {
    question: 'Find the mistake:',
    options: [
      'I hope to get the scholarship.',
      'She hopes not to fail the quiz.',
      'I wish you pass your English presentation.',
      'I hope you will join us.',
    ],
    correctIndex: 2,
    timeLimit: 30,
  },
  {
    question: 'Complete: "My parents hope ____ a new car soon."',
    options: ['buy', 'buying', 'to buy', 'they buys'],
    correctIndex: 2,
    timeLimit: 20,
  },
  {
    question: 'Complete: "They left an hour ago, so I hope they ____ home safely."',
    options: ['got', 'to get', 'getting', 'will got'],
    correctIndex: 0,
    timeLimit: 30,
  },
];

// The source deck defines a 5-question short version: questions 1, 2, 3, 4 and 6.
const SHORT_VERSION_QUESTION_NUMBERS = [1, 2, 3, 4, 6];

const QUESTION_SETS = {
  full: HOPE_QUESTIONS,
  short: SHORT_VERSION_QUESTION_NUMBERS.map((number) => HOPE_QUESTIONS[number - 1]),
};

const QUESTION_MODES = Object.keys(QUESTION_SETS);

function getQuestions(mode) {
  return (QUESTION_SETS[mode] || QUESTION_SETS.full).map((question) => ({
    timeLimit: DEFAULT_TIME_LIMIT_SECONDS,
    ...question,
  }));
}

module.exports = { getQuestions, QUESTION_MODES };
