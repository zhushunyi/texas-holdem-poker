const { buildDeck } = require('./cards');
const { eval7, compareHand } = require('./handEval');
const { buildSidePots } = require('./sidePots');

function cardKey(card) {
  return `${card.rank}${card.suit}`;
}

function combinations(arr, count) {
  if (count === 0) return [[]];

  const result = [];
  const current = [];

  function backtrack(startIndex) {
    if (current.length === count) {
      result.push(current.slice());
      return;
    }

    for (let index = startIndex; index <= arr.length - (count - current.length); index++) {
      current.push(arr[index]);
      backtrack(index + 1);
      current.pop();
    }
  }

  backtrack(0);
  return result;
}

function distributePotShares(pot, contenderMap, handMap, payouts) {
  const eligiblePlayers = pot.eligible.map((playerId) => contenderMap.get(playerId)).filter(Boolean);
  if (eligiblePlayers.length === 0) return;

  let bestHand = null;
  let winners = [];

  for (const player of eligiblePlayers) {
    const hand = handMap.get(player.id);
    if (!bestHand || compareHand(hand, bestHand) > 0) {
      bestHand = hand;
      winners = [player];
    } else if (compareHand(hand, bestHand) === 0) {
      winners.push(player);
    }
  }

  if (winners.length === 0) return;

  const share = pot.amount / winners.length;
  for (const winner of winners) {
    payouts.set(winner.id, (payouts.get(winner.id) || 0) + share);
  }
}

function calculateStageEquities(players, community, existingPots) {
  if (!Array.isArray(community) || community.length < 3) return {};

  const contenders = players.filter(
    (player) => player && (player.status === 'active' || player.status === 'allin') && Array.isArray(player.hole) && player.hole.length === 2,
  );
  if (contenders.length === 0) return {};

  const pots = existingPots && existingPots.length ? existingPots : buildSidePots(players);
  const totalPot = pots.reduce((sum, pot) => sum + pot.amount, 0);
  if (totalPot <= 0) return {};

  const knownCards = [];
  for (const card of community) knownCards.push(card);
  for (const player of players) {
    if (!player || !Array.isArray(player.hole)) continue;
    for (const card of player.hole) knownCards.push(card);
  }

  const knownCardKeys = new Set(knownCards.filter(Boolean).map(cardKey));
  const remainingDeck = buildDeck().filter((card) => !knownCardKeys.has(cardKey(card)));
  const missingCommunityCards = Math.max(0, 5 - community.length);
  const runouts = combinations(remainingDeck, missingCommunityCards);
  const contenderMap = new Map(contenders.map((player) => [player.id, player]));
  const equityMap = new Map(contenders.map((player) => [player.id, 0]));

  for (const runout of runouts) {
    const board = [...community, ...runout];
    const handMap = new Map();
    const payouts = new Map();

    for (const player of contenders) {
      handMap.set(player.id, eval7([...player.hole, ...board]));
    }

    for (const pot of pots) {
      distributePotShares(pot, contenderMap, handMap, payouts);
    }

    for (const player of contenders) {
      equityMap.set(player.id, equityMap.get(player.id) + (payouts.get(player.id) || 0) / totalPot);
    }
  }

  const simulations = runouts.length || 1;
  const percentages = {};
  for (const [playerId, equity] of equityMap.entries()) {
    percentages[playerId] = equity / simulations * 100;
  }

  return percentages;
}

module.exports = {
  calculateStageEquities,
};
