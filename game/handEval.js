// 5张牌牌型评估 + 7张取最优
// 返回结构：{ category, name, ranks }
// category: 9 RoyalFlush, 8 StraightFlush, 7 FourKind, 6 FullHouse, 5 Flush, 4 Straight, 3 ThreeKind, 2 TwoPair, 1 OnePair, 0 HighCard
// ranks: 用于同类型比较的关键牌点数组（从大到小）

const CATEGORY_NAME = {
  9: '皇家同花顺',
  8: '同花顺',
  7: '四条',
  6: '葫芦',
  5: '同花',
  4: '顺子',
  3: '三条',
  2: '两对',
  1: '一对',
  0: '高牌',
};

function sortDesc(arr) {
  return [...arr].sort((a, b) => b - a);
}

function isFlush(cards) {
  return cards.every((c) => c.suit === cards[0].suit);
}

function getStraightHigh(ranksSortedDescUnique) {
  // ranksSortedDescUnique: unique ranks desc
  // 处理A2345
  const ranks = [...ranksSortedDescUnique];
  if (ranks.includes(14)) ranks.push(1);

  let run = 1;
  for (let i = 0; i < ranks.length - 1; i++) {
    if (ranks[i] - 1 === ranks[i + 1]) {
      run += 1;
      if (run >= 5) {
        // 当出现5连时，straight high是起始最高牌（但A2345时 high=5）
        const high = ranks[i - 3];
        return high === 1 ? 5 : high;
      }
    } else {
      run = 1;
    }
  }
  return null;
}

function eval5(cards) {
  const ranks = cards.map((c) => c.rank);
  const ranksDesc = sortDesc(ranks);
  const flush = isFlush(cards);

  // 计数
  const countMap = new Map();
  for (const r of ranks) countMap.set(r, (countMap.get(r) || 0) + 1);

  // 排序：先按出现次数，再按点数
  const groups = [...countMap.entries()]
    .map(([rank, cnt]) => ({ rank, cnt }))
    .sort((a, b) => (b.cnt - a.cnt) || (b.rank - a.rank));

  const uniqueRanksDesc = [...new Set(ranksDesc)];
  const straightHigh = getStraightHigh(uniqueRanksDesc);
  const straight = straightHigh !== null;

  // 同花顺 / 皇家同花顺
  if (flush && straight) {
    if (straightHigh === 14) {
      return { category: 9, name: CATEGORY_NAME[9], ranks: [14] };
    }
    return { category: 8, name: CATEGORY_NAME[8], ranks: [straightHigh] };
  }

  // 四条
  if (groups[0].cnt === 4) {
    const quad = groups[0].rank;
    const kicker = groups.find((g) => g.cnt === 1).rank;
    return { category: 7, name: CATEGORY_NAME[7], ranks: [quad, kicker] };
  }

  // 葫芦
  if (groups[0].cnt === 3 && groups[1] && groups[1].cnt === 2) {
    return { category: 6, name: CATEGORY_NAME[6], ranks: [groups[0].rank, groups[1].rank] };
  }

  // 同花
  if (flush) {
    return { category: 5, name: CATEGORY_NAME[5], ranks: ranksDesc };
  }

  // 顺子
  if (straight) {
    return { category: 4, name: CATEGORY_NAME[4], ranks: [straightHigh] };
  }

  // 三条
  if (groups[0].cnt === 3) {
    const trips = groups[0].rank;
    const kickers = groups.filter((g) => g.cnt === 1).map((g) => g.rank).sort((a, b) => b - a);
    return { category: 3, name: CATEGORY_NAME[3], ranks: [trips, ...kickers] };
  }

  // 两对
  if (groups[0].cnt === 2 && groups[1] && groups[1].cnt === 2) {
    const highPair = Math.max(groups[0].rank, groups[1].rank);
    const lowPair = Math.min(groups[0].rank, groups[1].rank);
    const kicker = groups.find((g) => g.cnt === 1).rank;
    return { category: 2, name: CATEGORY_NAME[2], ranks: [highPair, lowPair, kicker] };
  }

  // 一对
  if (groups[0].cnt === 2) {
    const pair = groups[0].rank;
    const kickers = groups.filter((g) => g.cnt === 1).map((g) => g.rank).sort((a, b) => b - a);
    return { category: 1, name: CATEGORY_NAME[1], ranks: [pair, ...kickers] };
  }

  // 高牌
  return { category: 0, name: CATEGORY_NAME[0], ranks: ranksDesc };
}

function compareHand(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < len; i++) {
    const ar = a.ranks[i] || 0;
    const br = b.ranks[i] || 0;
    if (ar !== br) return ar - br;
  }
  return 0;
}

function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  function backtrack(start, comb) {
    if (comb.length === k) {
      res.push(comb.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      comb.push(arr[i]);
      backtrack(i + 1, comb);
      comb.pop();
    }
  }
  backtrack(0, []);
  return res;
}

function eval7(cards7) {
  const combs = combinations(cards7, 5);
  let best = null;
  for (const c of combs) {
    const v = eval5(c);
    if (!best || compareHand(v, best) > 0) best = v;
  }
  return best;
}

module.exports = {
  eval5,
  eval7,
  compareHand,
  CATEGORY_NAME,
};
