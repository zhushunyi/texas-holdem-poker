function isEligibleForPot(player) {
  return !!player && (player.status === 'active' || player.status === 'allin');
}

function buildSidePots(players) {
  const contribPlayers = players.filter((player) => player && player.contributed > 0);
  if (contribPlayers.length === 0) return [];

  const levels = [...new Set(contribPlayers.map((player) => player.contributed))].sort((a, b) => a - b);
  const pots = [];
  let previousLevel = 0;

  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    const contributors = contribPlayers.filter((player) => player.contributed >= level);
    const amount = (level - previousLevel) * contributors.length;

    previousLevel = level;
    if (amount <= 0) continue;

    const eligiblePlayers = contributors.filter(isEligibleForPot);

    pots.push({
      index,
      type: index === 0 ? 'main' : 'side',
      label: index === 0 ? '主池' : `边池 ${index}`,
      amount,
      eligible: eligiblePlayers.map((player) => player.id),
      eligibleSeatIndexes: eligiblePlayers.map((player) => player.seatIndex),
      eligibleNicknames: eligiblePlayers.map((player) => player.nickname),
      contributors: contributors.map((player) => player.id),
    });
  }

  return pots;
}

function hasAllInPlayer(players) {
  return players.some((player) => player && player.status === 'allin');
}

module.exports = {
  buildSidePots,
  hasAllInPlayer,
};
