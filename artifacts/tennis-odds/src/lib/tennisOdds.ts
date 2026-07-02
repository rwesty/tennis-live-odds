/**
 * Tennis Odds Math Engine — two-server iid model with full serve alternation
 *
 * Inputs:
 *   p1_s = P1 win% on own serve points     (user sets "P1 Serve Win %")
 *   p2_s = P2 win% on own serve points     (user sets "P2 Serve Win %")
 *
 * Derived:
 *   p1_r = 1 − p2_s  (P1 win% when P2 is serving)
 *   p2_r = 1 − p1_s  (P2 win% when P1 is serving)
 *
 * Serve alternation:
 *   Within a set   — alternates every game, tracked exactly.
 *   Across sets    — tracked via set-length parity:
 *                    Even-length set (6-0,6-1,6-2,6-3,6-4,7-5) → same player
 *                    serves first in next set.
 *                    Odd-length set (7-6 tiebreak = 13 games)   → other player
 *                    serves first in next set.
 *
 * No back-solve from pre-match probability. The live probability is computed
 * purely from serve inputs. `getImpliedPreMatchProb` lets the UI show what
 * the serve inputs imply at 0-0, and users can compare to the market price
 * they want to use as a shift reference.
 */

export interface MatchState {
  p1ServePct: number;         // P1 win% on own service points (0–1)
  p2ServePct: number;         // P2 win% on own service points (0–1)
  bestOf: 3 | 5;
  finalSetTiebreak: boolean;  // true = 10-pt match tiebreak in final set
  p1Sets: number;
  p2Sets: number;
  p1Games: number;
  p2Games: number;
  p1Points: number;           // 0=0, 1=15, 2=30, 3=40, 4=Adv
  p2Points: number;
  serving: 1 | 2;
  inTiebreak: boolean;
  p1TiebreakPoints: number;
  p2TiebreakPoints: number;
}

// ─── Module-level caches (pure functions — safe to cache globally) ──────────

const _gameCache = new Map<string, number>();
const _tbCache   = new Map<string, number>();

// ─── Point / game level ────────────────────────────────────────────────────

/**
 * P(P1 wins game from point score i-j) given p = P1 win prob per point.
 */
export function getGameWinProb(p: number, i: number, j: number): number {
  if (i >= 4 && i - j >= 2) return 1;
  if (j >= 4 && j - i >= 2) return 0;
  const key = `${p}|${i}|${j}`;
  const hit = _gameCache.get(key);
  if (hit !== undefined) return hit;
  let v: number;
  if (i === 3 && j === 3) {
    v = (p * p) / (p * p + (1 - p) * (1 - p));
  } else if (i === 4 && j === 3) {
    v = p + (1 - p) * getGameWinProb(p, 3, 3);
  } else if (i === 3 && j === 4) {
    v = p * getGameWinProb(p, 3, 3);
  } else {
    v = p * getGameWinProb(p, i + 1, j) + (1 - p) * getGameWinProb(p, i, j + 1);
  }
  _gameCache.set(key, v);
  return v;
}

// ─── Tiebreak level ────────────────────────────────────────────────────────

/**
 * P(P1 wins tiebreak from score i-j).
 * target=7 for standard tiebreak, target=10 for match tiebreak.
 * Uses a single p averaged over serve/return (serve alternates every 2 pts).
 */
export function getTiebreakWinProb(p: number, i: number, j: number, target = 7): number {
  if (i >= target && i - j >= 2) return 1;
  if (j >= target && j - i >= 2) return 0;
  const key = `${p}|${i}|${j}|${target}`;
  const hit = _tbCache.get(key);
  if (hit !== undefined) return hit;
  let v: number;
  if (i === target - 1 && j === target - 1) {
    v = (p * p) / (p * p + (1 - p) * (1 - p));
  } else {
    v = p * getTiebreakWinProb(p, i + 1, j, target)
      + (1 - p) * getTiebreakWinProb(p, i, j + 1, target);
  }
  _tbCache.set(key, v);
  return v;
}

// ─── Set level — outcome distribution ─────────────────────────────────────

/**
 * Returns [p1WinsNoTB, p1WinsTB, p2WinsNoTB, p2WinsTB] — the probability
 * that each outcome occurs, split by whether the set went to a tiebreak.
 *
 * Why this split matters for serve across sets:
 *   Non-TB sets have an even number of games → same player serves first in next set.
 *   TB sets have 13 games (odd)              → other player serves first in next set.
 *
 * @param i               P1 games won so far in this set
 * @param j               P2 games won so far in this set
 * @param p1_s            P1 win% when P1 serves
 * @param p1_r            P1 win% when P2 serves (= 1 − p2_s)
 * @param firstServer     who served game 0 of this set
 * @param currentGameProb if non-null, used as the win prob for game (i,j)
 *                        instead of computing it from firstServer + game index
 * @param p_tb_avg        average point win prob used for tiebreak calculation
 */
function setOutcomeDist(
  startI: number,
  startJ: number,
  p1_s: number,
  p1_r: number,
  firstServer: 1 | 2,
  currentGameProb: number | null,
  p_tb_avg: number,
): [number, number, number, number] {
  // Closure-scoped DP table: memoize all interior (i, j) states so each is
  // computed once. The starting cell may use currentGameProb so it is kept
  // outside the cache.
  const memo = new Map<number, [number, number, number, number]>();
  const otherServer: 1 | 2 = firstServer === 1 ? 2 : 1;

  function go(i: number, j: number, isStart: boolean): [number, number, number, number] {
    if ((i === 6 && j <= 4) || (i === 7 && j === 5)) return [1, 0, 0, 0];
    if ((j === 6 && i <= 4) || (j === 7 && i === 5)) return [0, 0, 1, 0];
    if (i === 6 && j === 6) {
      const p = getTiebreakWinProb(p_tb_avg, 0, 0, 7);
      return [0, p, 0, 1 - p];
    }
    // Use a single integer key — i*8+j fits in a tiny range (0..63)
    const key = i * 8 + j;
    if (!isStart) {
      const cached = memo.get(key);
      if (cached) return cached;
    }
    const gameIdx = i + j;
    const srv: 1 | 2 = gameIdx % 2 === 0 ? firstServer : otherServer;
    const p_game = isStart && currentGameProb !== null
      ? currentGameProb
      : (srv === 1 ? getGameWinProb(p1_s, 0, 0) : getGameWinProb(p1_r, 0, 0));

    const [a0, a1, a2, a3] = go(i + 1, j, false);
    const [b0, b1, b2, b3] = go(i, j + 1, false);
    const result: [number, number, number, number] = [
      p_game * a0 + (1 - p_game) * b0,
      p_game * a1 + (1 - p_game) * b1,
      p_game * a2 + (1 - p_game) * b2,
      p_game * a3 + (1 - p_game) * b3,
    ];
    if (!isStart) memo.set(key, result);
    return result;
  }

  return go(startI, startJ, true);
}

// ─── Set stats ─────────────────────────────────────────────────────────────

/**
 * Computes per-set baseline statistics from score 0-0 with P1 serving first.
 *
 * Returns:
 *   setWinProb         — P(P1 wins any given set)
 *   expectedGameSpread — E[P1 games − P2 games] over the completed set
 *                        (positive = P1 expected to win more games per set)
 *
 * Uses a small DP over the 49 possible (i, j) game-score states.
 */
export function computeSetStats(
  p1_s: number,
  p1_r: number,
  firstServer: 1 | 2,
  p_tb_avg: number,
  startI = 0,
  startJ = 0,
): { setWinProb: number; expectedGameSpread: number } {
  const otherServer: 1 | 2 = firstServer === 1 ? 2 : 1;
  const p_tb = getTiebreakWinProb(p_tb_avg, 0, 0, 7);
  // memo key = i * 10 + j (max 75, well within int range)
  const memo = new Map<number, [number, number]>(); // [setWinProb, expectedSpread]

  function go(i: number, j: number): [number, number] {
    // Terminal: non-tiebreak set winners
    if (i === 6 && j <= 4) return [1,  6 - j];
    if (j === 6 && i <= 4) return [0,  i - 6];
    if (i === 7 && j === 5) return [1,  2];
    if (j === 7 && i === 5) return [0, -2];
    // Tiebreak at 6-6: set ends 7-6 or 6-7
    if (i === 6 && j === 6) return [p_tb, 2 * p_tb - 1];

    const key = i * 10 + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const srv = (i + j) % 2 === 0 ? firstServer : otherServer;
    const p_game = srv === 1
      ? getGameWinProb(p1_s, 0, 0)
      : getGameWinProb(p1_r, 0, 0);

    const [pw, sw] = go(i + 1, j);
    const [pl, sl] = go(i, j + 1);

    const result: [number, number] = [
      p_game * pw + (1 - p_game) * pl,
      p_game * sw + (1 - p_game) * sl,
    ];
    memo.set(key, result);
    return result;
  }

  const [setWinProb, expectedGameSpread] = go(startI, startJ);
  return { setWinProb, expectedGameSpread };
}

/**
 * Expected total game spread (P1 games − P2 games) across ALL remaining sets
 * from the current live match state.
 *
 * Includes:
 *   - The in-progress set (computed from current game/tiebreak score)
 *   - All future sets that haven't started yet
 *
 * Add `sum(completedSetScores.map(s => s.p1 - s.p2))` externally to get the
 * full running match game spread.
 *
 * @param firstServerThisSet  who served game 0 of the current set
 * @param inTiebreak          true when the active set is in a 7-pt tiebreak
 * @param tbI / tbJ           tiebreak point score (used when inTiebreak is true)
 */
export function computeMatchGameSpread(
  p1_s: number,
  p1_r: number,
  firstServerThisSet: 1 | 2,
  p_tb_avg: number,
  p1Sets: number,
  p2Sets: number,
  setsToWin: number,
  finalSetTiebreak: boolean,
  p1Games: number,
  p2Games: number,
  inTiebreak: boolean,
  tbI: number,
  tbJ: number,
): number {
  const isFinalSet = p1Sets === setsToWin - 1 && p2Sets === setsToWin - 1;
  const otherServer: 1 | 2 = firstServerThisSet === 1 ? 2 : 1;

  // Expected game spread across sets that haven't started yet.
  // Keyed by s1*100 + s2*10 + srv (fits in tiny int range for both BO3 and BO5).
  const futureMemo = new Map<number, number>();
  function futureSetSpread(s1: number, s2: number, srv: 1 | 2): number {
    if (s1 === setsToWin || s2 === setsToWin) return 0;
    const k = s1 * 100 + s2 * 10 + srv;
    const hit = futureMemo.get(k);
    if (hit !== undefined) return hit;
    const isFinal = s1 === setsToWin - 1 && s2 === setsToWin - 1;
    let val: number;
    if (isFinal && finalSetTiebreak) {
      // 10-pt match tiebreak from 0-0: set result is 1-0 or 0-1
      val = 2 * getTiebreakWinProb(p_tb_avg, 0, 0, 10) - 1;
    } else {
      const other: 1 | 2 = srv === 1 ? 2 : 1;
      const ss = computeSetStats(p1_s, p1_r, srv, p_tb_avg);
      const [q1, q1tb, q2, q2tb] = setOutcomeDist(0, 0, p1_s, p1_r, srv, null, p_tb_avg);
      val = ss.expectedGameSpread
        + q1    * futureSetSpread(s1 + 1, s2, srv)
        + q1tb  * futureSetSpread(s1 + 1, s2, other)
        + q2    * futureSetSpread(s1, s2 + 1, srv)
        + q2tb  * futureSetSpread(s1, s2 + 1, other);
    }
    futureMemo.set(k, val);
    return val;
  }

  // ── Final-set match tiebreak ──────────────────────────────────────────────
  if (isFinalSet && finalSetTiebreak) {
    const p = getTiebreakWinProb(p_tb_avg, inTiebreak ? tbI : 0, inTiebreak ? tbJ : 0, 10);
    return 2 * p - 1;
  }

  // ── In-progress 7-pt tiebreak (game score is 6-6) ────────────────────────
  if (inTiebreak) {
    const p = getTiebreakWinProb(p_tb_avg, tbI, tbJ, 7);
    const setSpread = 2 * p - 1; // set ends 7-6 (+1) or 6-7 (−1)
    return (
      setSpread
      + p       * futureSetSpread(p1Sets + 1, p2Sets, otherServer)
      + (1 - p) * futureSetSpread(p1Sets, p2Sets + 1, otherServer)
    );
  }

  // ── Regular set from current game score ──────────────────────────────────
  const css = computeSetStats(p1_s, p1_r, firstServerThisSet, p_tb_avg, p1Games, p2Games);
  const [q1, q1tb, q2, q2tb] = setOutcomeDist(
    p1Games, p2Games, p1_s, p1_r, firstServerThisSet, null, p_tb_avg,
  );
  return (
    css.expectedGameSpread
    + q1    * futureSetSpread(p1Sets + 1, p2Sets, firstServerThisSet)
    + q1tb  * futureSetSpread(p1Sets + 1, p2Sets, otherServer)
    + q2    * futureSetSpread(p1Sets, p2Sets + 1, firstServerThisSet)
    + q2tb  * futureSetSpread(p1Sets, p2Sets + 1, otherServer)
  );
}

/**
 * Expected set spread (P1 sets − P2 sets) across ALL remaining sets from the
 * current live match state, including already-won sets.
 *
 * Mirrors computeMatchGameSpread but counts +1 / -1 per set rather than
 * game differences.
 */
export function computeMatchSetSpread(
  p1_s: number,
  p1_r: number,
  firstServerThisSet: 1 | 2,
  p_tb_avg: number,
  p1Sets: number,
  p2Sets: number,
  setsToWin: number,
  finalSetTiebreak: boolean,
  p1Games: number,
  p2Games: number,
  inTiebreak: boolean,
  tbI: number,
  tbJ: number,
): number {
  const isFinalSet = p1Sets === setsToWin - 1 && p2Sets === setsToWin - 1;
  const otherServer: 1 | 2 = firstServerThisSet === 1 ? 2 : 1;

  const futureMemo = new Map<number, number>();
  function futureSetMargin(s1: number, s2: number, srv: 1 | 2): number {
    if (s1 === setsToWin || s2 === setsToWin) return 0;
    const k = s1 * 100 + s2 * 10 + srv;
    const hit = futureMemo.get(k);
    if (hit !== undefined) return hit;
    const isFinal = s1 === setsToWin - 1 && s2 === setsToWin - 1;
    const other: 1 | 2 = srv === 1 ? 2 : 1;
    let val: number;
    if (isFinal && finalSetTiebreak) {
      const p = getTiebreakWinProb(p_tb_avg, 0, 0, 10);
      val = 2 * p - 1;
    } else {
      const [q1, q1tb, q2, q2tb] = setOutcomeDist(0, 0, p1_s, p1_r, srv, null, p_tb_avg);
      val = q1   * (1 + futureSetMargin(s1 + 1, s2, srv))
          + q1tb * (1 + futureSetMargin(s1 + 1, s2, other))
          + q2   * (-1 + futureSetMargin(s1, s2 + 1, srv))
          + q2tb * (-1 + futureSetMargin(s1, s2 + 1, other));
    }
    futureMemo.set(k, val);
    return val;
  }

  if (isFinalSet && finalSetTiebreak) {
    const p = getTiebreakWinProb(p_tb_avg, inTiebreak ? tbI : 0, inTiebreak ? tbJ : 0, 10);
    return (p1Sets - p2Sets) + (2 * p - 1);
  }

  if (inTiebreak) {
    const p = getTiebreakWinProb(p_tb_avg, tbI, tbJ, 7);
    return (p1Sets - p2Sets)
      + p       * (1 + futureSetMargin(p1Sets + 1, p2Sets, otherServer))
      + (1 - p) * (-1 + futureSetMargin(p1Sets, p2Sets + 1, otherServer));
  }

  const [q1, q1tb, q2, q2tb] = setOutcomeDist(
    p1Games, p2Games, p1_s, p1_r, firstServerThisSet, null, p_tb_avg,
  );
  return (p1Sets - p2Sets)
    + q1   * (1 + futureSetMargin(p1Sets + 1, p2Sets, firstServerThisSet))
    + q1tb * (1 + futureSetMargin(p1Sets + 1, p2Sets, otherServer))
    + q2   * (-1 + futureSetMargin(p1Sets, p2Sets + 1, firstServerThisSet))
    + q2tb * (-1 + futureSetMargin(p1Sets, p2Sets + 1, otherServer));
}

// ─── Match level ───────────────────────────────────────────────────────────

/**
 * P(P1 wins match) from current sets score, with full serve tracking.
 *
 * @param sets1             P1 sets won
 * @param sets2             P2 sets won
 * @param nextSetFirstServer who serves game 0 of the NEXT set to be played
 * @param isCurrentSet      true when computing from inside the active set
 * @param currentSetGameI   P1 games in active set (only used if isCurrentSet)
 * @param currentSetGameJ   P2 games in active set
 * @param currentGameProb   P(P1 wins current in-progress game), null if not in a game
 * @param inTiebreak        whether the active set is in a tiebreak
 * @param tbI / tbJ         tiebreak point score
 * @param setsToWin         2 for BO3, 3 for BO5
 * @param finalSetTiebreak  true = final set is a match tiebreak
 * @param p1_s / p1_r / p_tb_avg  serve probabilities
 */
function matchWinProb(
  sets1: number,
  sets2: number,
  nextSetFirstServer: 1 | 2,
  isCurrentSet: boolean,
  currentSetGameI: number,
  currentSetGameJ: number,
  currentGameProb: number | null,
  inTiebreak: boolean,
  tbI: number,
  tbJ: number,
  setsToWin: number,
  finalSetTiebreak: boolean,
  p1_s: number,
  p1_r: number,
  p_tb_avg: number,
): number {
  if (sets1 === setsToWin) return 1;
  if (sets2 === setsToWin) return 0;

  const isFinalSet = sets1 === setsToWin - 1 && sets2 === setsToWin - 1;

  // ── Active set calculation ──────────────────────────────────────────────
  if (isCurrentSet) {
    let p_set1: number; // P1 wins this set via non-tiebreak
    let p_set1_tb: number; // P1 wins via tiebreak
    let p_set2: number;
    let p_set2_tb: number;

    if (isFinalSet && finalSetTiebreak) {
      // Final set is a 10-pt match tiebreak — no regular set play
      const p = getTiebreakWinProb(p_tb_avg, tbI, tbJ, 10);
      return p;
    }

    if (inTiebreak) {
      // Active set is in its tiebreak (7-pt standard)
      const p = getTiebreakWinProb(p_tb_avg, tbI, tbJ, 7);
      // All tiebreak outcomes → next set server flips
      p_set1 = 0; p_set1_tb = p; p_set2 = 0; p_set2_tb = 1 - p;
    } else {
      [p_set1, p_set1_tb, p_set2, p_set2_tb] = setOutcomeDist(
        currentSetGameI, currentSetGameJ,
        p1_s, p1_r, nextSetFirstServer, currentGameProb, p_tb_avg,
      );
    }

    const otherServer: 1 | 2 = nextSetFirstServer === 1 ? 2 : 1;
    const noArgs = (s1: number, s2: number, srv: 1 | 2) =>
      matchWinProb(s1, s2, srv, false, 0, 0, null, false, 0, 0,
                   setsToWin, finalSetTiebreak, p1_s, p1_r, p_tb_avg);

    // Non-TB sets: same server continues; TB sets: server flips
    return (
        p_set1    * noArgs(sets1 + 1, sets2, nextSetFirstServer)
      + p_set1_tb * noArgs(sets1 + 1, sets2, otherServer)
      + p_set2    * noArgs(sets1, sets2 + 1, nextSetFirstServer)
      + p_set2_tb * noArgs(sets1, sets2 + 1, otherServer)
    );
  }

  // ── Future set (not yet started) ───────────────────────────────────────
  if (isFinalSet && finalSetTiebreak) {
    return getTiebreakWinProb(p_tb_avg, 0, 0, 10);
  }

  const [q1, q1_tb, q2, q2_tb] = setOutcomeDist(
    0, 0, p1_s, p1_r, nextSetFirstServer, null, p_tb_avg,
  );
  const otherServer: 1 | 2 = nextSetFirstServer === 1 ? 2 : 1;

  // Cache future-set recursion: keyed by sets1*100 + sets2*10 + srv
  if (!_futureSetCache) _futureSetCache = new Map<number, number>();
  const noArgs = (s1: number, s2: number, srv: 1 | 2): number => {
    const k = s1 * 100 + s2 * 10 + srv;
    const hit = _futureSetCache!.get(k);
    if (hit !== undefined) return hit;
    const v = matchWinProb(s1, s2, srv, false, 0, 0, null, false, 0, 0,
                           setsToWin, finalSetTiebreak, p1_s, p1_r, p_tb_avg);
    _futureSetCache!.set(k, v);
    return v;
  };

  return (
      q1    * noArgs(sets1 + 1, sets2, nextSetFirstServer)
    + q1_tb * noArgs(sets1 + 1, sets2, otherServer)
    + q2    * noArgs(sets1, sets2 + 1, nextSetFirstServer)
    + q2_tb * noArgs(sets1, sets2 + 1, otherServer)
  );
}

// per-call cache reset for matchWinProb future-set memoization
let _futureSetCache: Map<number, number> | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Compute P1 live win probability from current match state.
 */
export function calculateLiveMatchProb(state: MatchState): number {
  _futureSetCache = new Map(); // reset per call — serve params change between calls
  const p1_s = state.p1ServePct;
  const p2_s = state.p2ServePct;
  const p1_r = 1 - p2_s; // P1 win% when P2 is serving
  const p_tb_avg = (p1_s + p1_r) / 2;

  const setsToWin = state.bestOf === 3 ? 2 : 3;

  // Infer who served the first game of the current set from:
  //   current server + number of games already played this set
  const gamesPlayedThisSet = state.p1Games + state.p2Games;
  const firstServerThisSet: 1 | 2 =
    gamesPlayedThisSet % 2 === 0
      ? state.serving
      : (state.serving === 1 ? 2 : 1);

  // Current in-progress game win probability
  const currentGameProb = state.inTiebreak
    ? null // tiebreak state handled separately
    : (state.serving === 1
        ? getGameWinProb(p1_s, state.p1Points, state.p2Points)
        : getGameWinProb(p1_r, state.p1Points, state.p2Points));

  return Math.max(
    0.001,
    Math.min(
      0.999,
      matchWinProb(
        state.p1Sets, state.p2Sets,
        firstServerThisSet,
        true,
        state.p1Games, state.p2Games,
        currentGameProb,
        state.inTiebreak,
        state.p1TiebreakPoints, state.p2TiebreakPoints,
        setsToWin,
        state.finalSetTiebreak,
        p1_s, p1_r, p_tb_avg,
      ),
    ),
  );
}

/**
 * Compute the match win probability implied by the serve inputs at score 0-0,
 * assuming P1 serves first. Use this to show users what their serve inputs
 * imply for the pre-match probability.
 */
export function getImpliedPreMatchProb(
  p1ServePct: number,
  p2ServePct: number,
  bestOf: 3 | 5,
  finalSetTiebreak: boolean,
): number {
  _futureSetCache = new Map();
  const p1_r = 1 - p2ServePct;
  const p_tb_avg = (p1ServePct + p1_r) / 2;
  const setsToWin = bestOf === 3 ? 2 : 3;
  return Math.max(
    0.001,
    Math.min(
      0.999,
      matchWinProb(
        0, 0, 1, false, 0, 0, null, false, 0, 0,
        setsToWin, finalSetTiebreak, p1ServePct, p1_r, p_tb_avg,
      ),
    ),
  );
}

// ─── State transition ──────────────────────────────────────────────────────

/**
 * Advance the match state by one point. Returns the new MatchState.
 * If the match is already decided the state is returned unchanged.
 */
export function advancePoint(state: MatchState, pointWinner: 1 | 2): MatchState {
  const setsToWin = state.bestOf === 3 ? 2 : 3;
  if (state.p1Sets >= setsToWin || state.p2Sets >= setsToWin) return state;

  const isFinalSet = state.p1Sets === setsToWin - 1 && state.p2Sets === setsToWin - 1;
  const isMatchTiebreak = isFinalSet && state.finalSetTiebreak;

  if (state.inTiebreak) {
    return _advanceTiebreakPoint(state, pointWinner, isMatchTiebreak, setsToWin);
  }
  return _advanceRegularPoint(state, pointWinner, setsToWin);
}

function _advanceTiebreakPoint(
  state: MatchState,
  pointWinner: 1 | 2,
  isMatchTiebreak: boolean,
  setsToWin: number,
): MatchState {
  const tbTarget = isMatchTiebreak ? 10 : 7;
  const s = { ...state };

  if (pointWinner === 1) s.p1TiebreakPoints++;
  else s.p2TiebreakPoints++;

  const p1 = s.p1TiebreakPoints, p2 = s.p2TiebreakPoints;
  if ((p1 >= tbTarget && p1 - p2 >= 2) || (p2 >= tbTarget && p2 - p1 >= 2)) {
    const tbWinner: 1 | 2 = p1 > p2 ? 1 : 2;
    // Tiebreak server = first server of this set (game index 12 is even).
    // 13-game set is odd → next set first server flips.
    const firstServerThisSet = s.serving;
    if (tbWinner === 1) s.p1Sets++;
    else s.p2Sets++;
    s.p1Games = 0; s.p2Games = 0;
    s.p1Points = 0; s.p2Points = 0;
    s.inTiebreak = false;
    s.p1TiebreakPoints = 0; s.p2TiebreakPoints = 0;
    s.serving = firstServerThisSet === 1 ? 2 : 1; // odd set → flip
  } else {
    // Switch serve after 1st tiebreak point, then every 2 points
    const total = s.p1TiebreakPoints + s.p2TiebreakPoints;
    if (total % 2 === 1) s.serving = s.serving === 1 ? 2 : 1;
  }

  return s;
}

function _advanceRegularPoint(
  state: MatchState,
  pointWinner: 1 | 2,
  setsToWin: number,
): MatchState {
  let s = { ...state };
  const p1 = s.p1Points, p2 = s.p2Points;
  let gameWinner: 1 | 2 | null = null;

  if (p1 === 4) {
    // P1 has Adv
    if (pointWinner === 1) gameWinner = 1;
    else { s.p1Points = 3; s.p2Points = 3; }
  } else if (p2 === 4) {
    // P2 has Adv
    if (pointWinner === 2) gameWinner = 2;
    else { s.p1Points = 3; s.p2Points = 3; }
  } else if (pointWinner === 1) {
    if (p1 === 3 && p2 === 3)  s.p1Points = 4;   // Adv P1
    else if (p1 === 3)          gameWinner = 1;    // 40-0/15/30
    else                         s.p1Points++;
  } else {
    if (p2 === 3 && p1 === 3)  s.p2Points = 4;   // Adv P2
    else if (p2 === 3)          gameWinner = 2;    // 40-0/15/30
    else                         s.p2Points++;
  }

  if (gameWinner !== null) s = _wonGame(s, gameWinner, setsToWin);
  return s;
}

function _wonGame(state: MatchState, gameWinner: 1 | 2, setsToWin: number): MatchState {
  let s = { ...state };
  const prevServer = s.serving;

  if (gameWinner === 1) s.p1Games++;
  else s.p2Games++;
  s.p1Points = 0; s.p2Points = 0;

  const g1 = s.p1Games, g2 = s.p2Games;

  // 6-6 → tiebreak
  if (g1 === 6 && g2 === 6) {
    s.inTiebreak = true;
    s.p1TiebreakPoints = 0; s.p2TiebreakPoints = 0;
    s.serving = prevServer === 1 ? 2 : 1;
    return s;
  }

  const setWon = (g1 === 6 && g2 <= 4) || (g2 === 6 && g1 <= 4) ||
                 (g1 === 7 && g2 === 5) || (g2 === 7 && g1 === 5);

  if (setWon) {
    const sw: 1 | 2 = g1 > g2 ? 1 : 2;
    const totalGames = g1 + g2;
    // prevServer served the last game (index totalGames−1)
    const lastGameIdx = totalGames - 1;
    const firstServer: 1 | 2 = lastGameIdx % 2 === 0
      ? prevServer : (prevServer === 1 ? 2 : 1);
    const nextServer: 1 | 2 = totalGames % 2 === 0
      ? firstServer : (firstServer === 1 ? 2 : 1);

    if (sw === 1) s.p1Sets++;
    else s.p2Sets++;
    s.p1Games = 0; s.p2Games = 0;
    s.serving = nextServer;
  } else {
    s.serving = prevServer === 1 ? 2 : 1;
  }

  return s;
}

/**
 * Back-solve symmetric serve percentages from a target pre-match probability.
 *
 * Both players are adjusted by the same delta away from the tour baseline:
 *   P1ServePct = baseline + delta   (stronger player serves better)
 *   P2ServePct = baseline − delta   (weaker player serves worse)
 *
 * Delta is searched in [−(baseline−0.50), 0.30] so both values stay in [50%, 80%].
 * Returns { p1ServePct, p2ServePct } as floating-point percentages (e.g. 63.4).
 */
export function backsolveSymmetricServes(
  targetPreMatch: number,
  baselinePct: number,          // e.g. 0.63 for ATP, 0.58 for WTA
  bestOf: 3 | 5,
  finalSetTiebreak: boolean,
): { p1ServePct: number; p2ServePct: number } {
  const maxDelta = Math.min(0.30, 0.80 - baselinePct);   // P1 capped at 80%
  const minDelta = -(baselinePct - 0.50);                 // P2 floored at 50%
  let lo = minDelta, hi = maxDelta;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (getImpliedPreMatchProb(baselinePct + mid, baselinePct - mid, bestOf, finalSetTiebreak) < targetPreMatch) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const delta = (lo + hi) / 2;
  return {
    p1ServePct: (baselinePct + delta) * 100,
    p2ServePct: (baselinePct - delta) * 100,
  };
}

// ─── Odds formatting ───────────────────────────────────────────────────────

export function probToAmericanOdds(prob: number): number {
  if (prob >= 0.5) return Math.round(-(prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

export function probToDecimalOdds(prob: number): number {
  return Number((1 / prob).toFixed(2));
}

export function formatAmericanOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}
