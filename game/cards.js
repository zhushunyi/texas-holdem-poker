const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function rankToLabel(r) {
  if (r <= 10) return String(r);
  if (r === 11) return 'J';
  if (r === 12) return 'Q';
  if (r === 13) return 'K';
  return 'A';
}

function suitToSymbol(s) {
  if (s === 'S') return '♠';
  if (s === 'H') return '♥';
  if (s === 'D') return '♦';
  return '♣';
}

function cardToString(card) {
  return `${rankToLabel(card.rank)}${card.suit}`;
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function shuffle(deck) {
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = {
  SUITS,
  RANKS,
  rankToLabel,
  suitToSymbol,
  cardToString,
  buildDeck,
  shuffle,
};
