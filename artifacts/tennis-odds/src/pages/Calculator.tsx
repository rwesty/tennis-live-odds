import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  calculateLiveMatchProb,
  getImpliedPreMatchProb,
  backsolveSymmetricServes,
  computeSetStats,
  computeMatchGameSpread,
  computeMatchSetSpread,
  advancePoint,
  formatAmericanOdds,
  probToAmericanOdds,
  probToDecimalOdds,
  type MatchState,
} from "@/lib/tennisOdds";
import { scrapeMatch, type ScrapedMatch } from "@/lib/flashscoreScraper";

const POINT_LABELS = ["0", "15", "30", "40", "Adv"];

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function NumberStepper({
  value,
  onChange,
  min,
  max,
  label,
  testId,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label?: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-muted-foreground w-16">{label}</span>}
      <div className="flex items-center gap-1">
        <button
          data-testid={`${testId}-dec`}
          onClick={() => onChange(clamp(value - 1, min, max))}
          className="w-7 h-7 rounded border border-border bg-secondary text-foreground hover:bg-accent flex items-center justify-center text-sm font-bold transition-colors"
        >
          −
        </button>
        <span
          data-testid={`${testId}-val`}
          className="w-8 text-center font-mono text-sm font-semibold tabular-nums"
        >
          {value}
        </span>
        <button
          data-testid={`${testId}-inc`}
          onClick={() => onChange(clamp(value + 1, min, max))}
          className="w-7 h-7 rounded border border-border bg-secondary text-foreground hover:bg-accent flex items-center justify-center text-sm font-bold transition-colors"
        >
          +
        </button>
      </div>
    </div>
  );
}

function OddsCard({
  playerName,
  prob,
  preMatchProb,
  isP1,
}: {
  playerName: string;
  prob: number;
  preMatchProb: number;
  isP1: boolean;
}) {
  const americanOdds = probToAmericanOdds(prob);
  const decimalOdds = probToDecimalOdds(prob);
  const shift = (prob - preMatchProb) * 100;
  const positive = isP1 ? shift > 0 : shift < 0;
  const shiftAbs = Math.abs(shift);

  return (
    <div
      data-testid={`odds-card-${isP1 ? "p1" : "p2"}`}
      className="flex-1 rounded-xl border border-border bg-card p-5 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: isP1 ? "hsl(82,100%,50%)" : "hsl(0,72%,51%)" }}
        />
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground truncate">
          {playerName}
        </span>
      </div>

      <div
        data-testid={`odds-american-${isP1 ? "p1" : "p2"}`}
        className="text-5xl font-black font-mono tabular-nums"
        style={{ color: isP1 ? "hsl(82,100%,50%)" : "hsl(0,72%,51%)" }}
      >
        {formatAmericanOdds(americanOdds)}
      </div>

      <div className="flex items-center gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Decimal</div>
          <div data-testid={`odds-decimal-${isP1 ? "p1" : "p2"}`} className="text-lg font-mono font-bold tabular-nums">
            {decimalOdds.toFixed(2)}
          </div>
        </div>
        <div className="w-px h-8 bg-border" />
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Win %</div>
          <div data-testid={`odds-prob-${isP1 ? "p1" : "p2"}`} className="text-lg font-mono font-bold tabular-nums">
            {(prob * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {shiftAbs >= 0.05 && (
        <div
          data-testid={`odds-shift-${isP1 ? "p1" : "p2"}`}
          className={`text-xs font-semibold rounded px-2 py-1 inline-flex items-center gap-1 w-fit ${
            positive
              ? "bg-green-950 text-green-400 border border-green-800"
              : "bg-red-950 text-red-400 border border-red-800"
          }`}
        >
          {positive ? "▲" : "▼"} {shiftAbs.toFixed(1)}% from pre-match
        </div>
      )}
    </div>
  );
}

function ProbBar({ p1Prob }: { p1Prob: number }) {
  const p2Prob = 1 - p1Prob;
  return (
    <div data-testid="prob-bar" className="w-full flex rounded-full overflow-hidden h-3 border border-border">
      <div
        className="h-full transition-all duration-300"
        style={{ width: `${p1Prob * 100}%`, background: "hsl(82,100%,45%)" }}
      />
      <div
        className="h-full transition-all duration-300"
        style={{ width: `${p2Prob * 100}%`, background: "hsl(0,72%,51%)" }}
      />
    </div>
  );
}

export default function Calculator() {
  // URL scraping
  const [url, setUrl] = useState("");
  const [scrapeStatus, setScrapeStatus] = useState<"idle" | "loading" | "live" | "finished" | "not_started" | "error">("idle");
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [scrapedData, setScrapedData] = useState<ScrapedMatch | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tour type and serve baselines
  const [tourType, setTourType] = useState<"atp" | "wta">("atp");
  const tourBaseline = tourType === "atp" ? 63 : 58;

  // Match config
  const [p1Name, setP1Name] = useState("Player 1");
  const [p2Name, setP2Name] = useState("Player 2");
  const [p1PrematchPct, setP1PrematchPct] = useState(50);
  const [p1ServePct, setP1ServePct] = useState(63);
  const [p2ServePct, setP2ServePct] = useState(63);
  const [serveManuallySet, setServeManuallySet] = useState(false);
  const [bestOf, setBestOf] = useState<3 | 5>(3);
  const [finalSetTiebreak, setFinalSetTiebreak] = useState(true);

  // Score state
  const [p1Sets, setP1Sets] = useState(0);
  const [p2Sets, setP2Sets] = useState(0);
  const [p1Games, setP1Games] = useState(0);
  const [p2Games, setP2Games] = useState(0);
  const [p1Points, setP1Points] = useState(0);
  const [p2Points, setP2Points] = useState(0);
  const [serving, setServing] = useState<1 | 2>(1);
  const [inTiebreak, setInTiebreak] = useState(false);
  const [p1TiebreakPoints, setP1TiebreakPoints] = useState(0);
  const [p2TiebreakPoints, setP2TiebreakPoints] = useState(0);

  // Completed set scores — tracked to compute live running game spread
  const [completedSetScores, setCompletedSetScores] = useState<{ p1: number; p2: number }[]>([]);

  // Keep completedSetScores array sized to the number of completed sets.
  // New entries default to (6, 3) for P1 sets and (3, 6) for P2 sets by position.
  useEffect(() => {
    const total = p1Sets + p2Sets;
    setCompletedSetScores(prev => {
      if (prev.length === total) return prev;
      if (prev.length > total) return prev.slice(0, total);
      // Pad — use a naive alternating default; user corrects via inputs
      const added = Array.from({ length: total - prev.length }, (_, i) => {
        const idx = prev.length + i;
        return idx % 2 === 0 ? { p1: 6, p2: 3 } : { p1: 3, p2: 6 };
      });
      return [...prev, ...added];
    });
  }, [p1Sets, p2Sets]);

  // Populate from scraped data
  const applyScrapedData = useCallback((data: ScrapedMatch) => {
    setP1Name(data.p1Name || "Player 1");
    setP2Name(data.p2Name || "Player 2");
    // All entries in data.sets are COMPLETED sets; p1Games/p2Games is the current in-progress set
    const completedSets = data.sets;
    let cs1 = 0, cs2 = 0;
    for (const [a, b] of completedSets) {
      if (a > b) cs1++;
      else cs2++;
    }
    setP1Sets(cs1);
    setP2Sets(cs2);
    setCompletedSetScores(completedSets.map(([p1, p2]) => ({ p1, p2 })));
    setP1Games(data.p1Games);
    setP2Games(data.p2Games);
    setP1Points(data.p1Points);
    setP2Points(data.p2Points);
    if (data.serving) setServing(data.serving);
    setInTiebreak(data.inTiebreak);
    setP1TiebreakPoints(data.p1TiebreakPoints);
    setP2TiebreakPoints(data.p2TiebreakPoints);
    setLastUpdated(Date.now());
  }, []);

  const doScrape = useCallback(async (targetUrl: string) => {
    setScrapeStatus("loading");
    setScrapeError(null);
    try {
      const data = await scrapeMatch(targetUrl);
      setScrapedData(data);
      setScrapeStatus(data.status);
      if (data.status === "live") {
        applyScrapedData(data);
      }
    } catch (e) {
      setScrapeError((e as Error).message);
      setScrapeStatus("error");
    }
  }, [applyScrapedData]);

  const handleLoadMatch = () => {
    if (!url.trim()) return;
    // Clear previous polling
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    doScrape(url.trim());
  };

  // Poll every 30s when live
  useEffect(() => {
    if (scrapeStatus === "live" && url) {
      pollIntervalRef.current = setInterval(() => {
        doScrape(url);
      }, 30000);
      return () => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      };
    }
  }, [scrapeStatus, url, doScrape]);

  // Update "X seconds ago" counter
  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  // Auto-calibrate serve % whenever pre-match prob, tour type, or format changes
  // — but only when the user hasn't manually locked the sliders.
  useEffect(() => {
    if (serveManuallySet) return;
    const baseline = tourType === "atp" ? 63 : 58;
    const { p1ServePct: s1, p2ServePct: s2 } = backsolveSymmetricServes(
      p1PrematchPct / 100, baseline / 100, bestOf, finalSetTiebreak,
    );
    setP1ServePct(s1);
    setP2ServePct(s2);
  }, [p1PrematchPct, tourType, bestOf, finalSetTiebreak, serveManuallySet]);

  const setsToWin = bestOf === 3 ? 2 : 3;

  // Validation
  const warnings: string[] = [];
  if (p1Sets + p2Sets > bestOf - 1) warnings.push("Sets won exceed match format.");
  if (p1Sets >= setsToWin || p2Sets >= setsToWin) warnings.push("Match already has a winner — reset scores.");
  if (p1Games > 7 || p2Games > 7) warnings.push("Game score out of range (max 7).");
  if (p1Games === 7 && p2Games === 7) warnings.push("Both players at 7 games is invalid.");
  if (inTiebreak && (p1Points > 0 || p2Points > 0)) warnings.push("Use tiebreak point inputs when in tiebreak.");

  const matchState = useMemo<MatchState>(() => ({
    p1ServePct: p1ServePct / 100,
    p2ServePct: p2ServePct / 100,
    bestOf,
    finalSetTiebreak,
    p1Sets,
    p2Sets,
    p1Games,
    p2Games,
    p1Points,
    p2Points,
    serving,
    inTiebreak,
    p1TiebreakPoints,
    p2TiebreakPoints,
  }), [p1ServePct, p2ServePct, bestOf, finalSetTiebreak, p1Sets, p2Sets, p1Games, p2Games, p1Points, p2Points, serving, inTiebreak, p1TiebreakPoints, p2TiebreakPoints]);

  // Server-neutral Set 1 win % — averaged over both coin-toss outcomes, used in the pre-match anchor
  const set1WinPctNeutral = useMemo(() => {
    const p1_s = p1ServePct / 100;
    const p2_s = p2ServePct / 100;
    const p1_r = 1 - p2_s;
    const p_tb_avg = (p1_s + p1_r) / 2;
    return (computeSetStats(p1_s, p1_r, 1, p_tb_avg).setWinProb +
            computeSetStats(p1_s, p1_r, 2, p_tb_avg).setWinProb) / 2;
  }, [p1ServePct, p2ServePct]);

  // Who served the first game of the current set
  const firstServerThisSet: 1 | 2 = useMemo(() => {
    const gamesPlayed = p1Games + p2Games;
    return gamesPlayed % 2 === 0 ? serving : (serving === 1 ? 2 : 1);
  }, [p1Games, p2Games, serving]);

  // Live set stats: current set win % from actual game state + list of upcoming set win %s
  const liveSetStats = useMemo(() => {
    const p1_s = p1ServePct / 100;
    const p2_s = p2ServePct / 100;
    const p1_r = 1 - p2_s;
    const p_tb_avg = (p1_s + p1_r) / 2;
    const isFinalSet = p1Sets === setsToWin - 1 && p2Sets === setsToWin - 1;
    const completedSets = p1Sets + p2Sets;
    const currentSetNumber = completedSets + 1;
    const serverKnown = (p1Games + p2Games) === 0;

    // Current set win % from live game score (clamp to 6-6 for mid-tiebreak states)
    const gi = inTiebreak ? 6 : p1Games;
    const gj = inTiebreak ? 6 : p2Games;
    const currentWinProb = computeSetStats(p1_s, p1_r, firstServerThisSet, p_tb_avg, gi, gj).setWinProb;

    // Server-neutral win % used for all upcoming (not-yet-started) sets
    const neutralWinProb = (
      computeSetStats(p1_s, p1_r, 1, p_tb_avg).setWinProb +
      computeSetStats(p1_s, p1_r, 2, p_tb_avg).setWinProb
    ) / 2;

    // Upcoming sets (only when not already in the final set)
    const maxSets = setsToWin * 2 - 1;
    const upcomingSets: { setNum: number; winProb: number }[] = [];
    if (!isFinalSet) {
      for (let s = currentSetNumber + 1; s <= maxSets; s++) {
        upcomingSets.push({ setNum: s, winProb: neutralWinProb });
      }
    }

    return { currentSetNumber, currentWinProb, isFinalSet, upcomingSets, serverKnown };
  }, [p1ServePct, p2ServePct, p1Sets, p2Sets, setsToWin, p1Games, p2Games, inTiebreak, firstServerThisSet]);

  // Expected game spread across the full match from 0-0 (pre-game baseline).
  // Averaged over both first-server possibilities — we don't know the coin toss yet.
  const preMatchGameSpread = useMemo(() => {
    const p1_s = p1ServePct / 100;
    const p2_s = p2ServePct / 100;
    const p1_r = 1 - p2_s;
    const p_tb_avg = (p1_s + p1_r) / 2;
    const spreadP1First = computeMatchGameSpread(p1_s, p1_r, 1, p_tb_avg, 0, 0, setsToWin, finalSetTiebreak, 0, 0, false, 0, 0);
    const spreadP2First = computeMatchGameSpread(p1_s, p1_r, 2, p_tb_avg, 0, 0, setsToWin, finalSetTiebreak, 0, 0, false, 0, 0);
    return (spreadP1First + spreadP2First) / 2;
  }, [p1ServePct, p2ServePct, setsToWin, finalSetTiebreak]);

  // Live game spread: locked scores from completed sets + expected remaining
  const liveGameSpread = useMemo(() => {
    const p1_s = p1ServePct / 100;
    const p2_s = p2ServePct / 100;
    const p1_r = 1 - p2_s;
    const p_tb_avg = (p1_s + p1_r) / 2;
    const completedSpread = completedSetScores.reduce((sum, s) => sum + s.p1 - s.p2, 0);
    const remainingSpread = computeMatchGameSpread(
      p1_s, p1_r, firstServerThisSet, p_tb_avg,
      p1Sets, p2Sets, setsToWin, finalSetTiebreak,
      p1Games, p2Games,
      inTiebreak, p1TiebreakPoints, p2TiebreakPoints,
    );
    return completedSpread + remainingSpread;
  }, [
    p1ServePct, p2ServePct, firstServerThisSet,
    p1Sets, p2Sets, setsToWin, finalSetTiebreak,
    p1Games, p2Games, inTiebreak, p1TiebreakPoints, p2TiebreakPoints,
    completedSetScores,
  ]);

  // Live sets spread: (P1 sets won − P2 sets won) expected across the full match
  const liveSetSpread = useMemo(() => {
    const p1_s = p1ServePct / 100;
    const p2_s = p2ServePct / 100;
    const p1_r = 1 - p2_s;
    const p_tb_avg = (p1_s + p1_r) / 2;
    return computeMatchSetSpread(
      p1_s, p1_r, firstServerThisSet, p_tb_avg,
      p1Sets, p2Sets, setsToWin, finalSetTiebreak,
      p1Games, p2Games, inTiebreak,
      p1TiebreakPoints, p2TiebreakPoints,
    );
  }, [
    p1ServePct, p2ServePct, firstServerThisSet,
    p1Sets, p2Sets, setsToWin, finalSetTiebreak,
    p1Games, p2Games, inTiebreak, p1TiebreakPoints, p2TiebreakPoints,
  ]);

  // Model-implied pre-match probability from serve inputs at score 0-0, P1 serving first
  const impliedPreMatchP1 = useMemo(
    () => getImpliedPreMatchProb(p1ServePct / 100, p2ServePct / 100, bestOf, finalSetTiebreak),
    [p1ServePct, p2ServePct, bestOf, finalSetTiebreak],
  );

  // Log-odds calibration: anchors live output to user's pre-match probability.
  // At 0-0 the result equals userPreMatch exactly; at other scores the log-odds
  // are shifted by the same constant so serve % still drives point-by-point movement.
  const preMatchP1 = p1PrematchPct / 100;
  const preMatchP2 = 1 - preMatchP1;

  const calibrate = useCallback(
    (rawProb: number): number => {
      const logit = (p: number) => Math.log(p / (1 - p));
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
      const shift = logit(preMatchP1) - logit(impliedPreMatchP1);
      return Math.max(0.001, Math.min(0.999, sigmoid(logit(rawProb) + shift)));
    },
    [preMatchP1, impliedPreMatchP1],
  );

  const liveP1Prob = useMemo(() => {
    try {
      return calibrate(calculateLiveMatchProb(matchState));
    } catch {
      return preMatchP1;
    }
  }, [matchState, calibrate, preMatchP1]);

  const liveP2Prob = 1 - liveP1Prob;

  // Next-point scenario states and probabilities
  const stateIfP1WinsPoint = useMemo(() => advancePoint(matchState, 1), [matchState]);
  const stateIfP2WinsPoint = useMemo(() => advancePoint(matchState, 2), [matchState]);

  const probIfP1WinsPoint = useMemo(() => {
    try { return calibrate(calculateLiveMatchProb(stateIfP1WinsPoint)); }
    catch { return liveP1Prob; }
  }, [stateIfP1WinsPoint, calibrate, liveP1Prob]);

  const probIfP2WinsPoint = useMemo(() => {
    try { return calibrate(calculateLiveMatchProb(stateIfP2WinsPoint)); }
    catch { return liveP1Prob; }
  }, [stateIfP2WinsPoint, calibrate, liveP1Prob]);

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-1 h-10 rounded-full" style={{ background: "hsl(82,100%,50%)" }} />
          <div>
            <h1 className="text-2xl font-black tracking-tight">Tennis Live Odds Calculator</h1>
            <p className="text-xs text-muted-foreground tracking-wide">Vig-free in-play probabilities using the iid point model</p>
          </div>
        </div>

        {/* === SECTION 1: URL Loader === */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Match Loader</div>

          <div className="flex gap-2">
            <input
              data-testid="input-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLoadMatch()}
              placeholder="https://www.flashscoreusa.com/match/..."
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary transition-all"
            />
            <button
              data-testid="button-load-match"
              onClick={handleLoadMatch}
              disabled={scrapeStatus === "loading" || !url.trim()}
              className="rounded-lg px-4 py-2 text-sm font-bold transition-all disabled:opacity-40"
              style={{ background: "hsl(82,100%,45%)", color: "hsl(222,47%,8%)" }}
            >
              {scrapeStatus === "loading" ? "Loading..." : "Load Match"}
            </button>
          </div>

          {/* Status display */}
          {scrapeStatus === "error" && (
            <div data-testid="status-error" className="text-sm text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2">
              {scrapeError}
              <div className="text-xs text-red-500 mt-1">Use manual score entry below — all fields remain editable.</div>
            </div>
          )}
          {scrapeStatus === "not_started" && (
            <div data-testid="status-not-started" className="text-sm text-yellow-400 bg-yellow-950 border border-yellow-800 rounded-lg px-3 py-2">
              Match has not started yet.
            </div>
          )}
          {scrapeStatus === "finished" && scrapedData && (
            <div data-testid="status-finished" className="text-sm text-muted-foreground bg-secondary border border-border rounded-lg px-3 py-2">
              Match is finished — {scrapedData.p1Name} vs {scrapedData.p2Name}
            </div>
          )}
          {scrapeStatus === "live" && (
            <div data-testid="status-live" className="flex items-center gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-green-400 font-semibold">Live</span>
              </span>
              {lastUpdated && (
                <span data-testid="last-updated" className="text-muted-foreground text-xs">
                  Last updated: {secondsAgo}s ago · auto-refreshes every 30s
                </span>
              )}
            </div>
          )}
        </div>

        {/* === SECTION 2: Inputs === */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-6">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Match Configuration</div>

          {/* Player names */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Player 1 Name</label>
              <input
                data-testid="input-p1-name"
                value={p1Name}
                onChange={(e) => setP1Name(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Player 2 Name</label>
              <input
                data-testid="input-p2-name"
                value={p2Name}
                onChange={(e) => setP2Name(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Pre-match probability */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Pre-Match Win Probability (vig-free)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 shrink-0">
                <input
                  data-testid="input-p1-prob"
                  type="number"
                  min={1}
                  max={99}
                  value={p1PrematchPct}
                  onChange={(e) => setP1PrematchPct(clamp(Number(e.target.value), 1, 99))}
                  className="w-14 rounded border border-border bg-background px-2 py-1 text-sm font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-xs text-muted-foreground w-20 truncate">{p1Name}</span>
                <input
                  data-testid="slider-p1-prob"
                  type="range"
                  min={1}
                  max={99}
                  value={p1PrematchPct}
                  onChange={(e) => setP1PrematchPct(Number(e.target.value))}
                  className="flex-1 accent-primary"
                />
                <span className="text-xs text-muted-foreground w-20 text-right truncate">{p2Name}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  data-testid="input-p2-prob"
                  type="number"
                  min={1}
                  max={99}
                  value={100 - p1PrematchPct}
                  onChange={(e) => setP1PrematchPct(clamp(100 - Number(e.target.value), 1, 99))}
                  className="w-14 rounded border border-border bg-background px-2 py-1 text-sm font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>

            </div>
            <div className="flex justify-between text-xs font-mono text-muted-foreground">
              <span data-testid="prob-display-p1">{p1Name}: {p1PrematchPct}%</span>
              <span data-testid="prob-display-p2">{p2Name}: {100 - p1PrematchPct}%</span>
            </div>
          </div>

          {/* Tour type + Serve win % */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Serve Win %
                </label>
                {/* ATP / WTA toggle */}
                <div className="flex gap-1">
                  {(["atp", "wta"] as const).map((t) => (
                    <button
                      key={t}
                      data-testid={`button-tour-${t}`}
                      onClick={() => {
                        setTourType(t);
                        setServeManuallySet(false);
                      }}
                      className={`px-2 py-0.5 rounded text-xs font-bold border transition-all uppercase ${
                        tourType === t
                          ? "border-primary text-primary bg-primary/10"
                          : "border-border text-muted-foreground hover:border-muted-foreground"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {/* auto / manual badge */}
                {serveManuallySet ? (
                  <span className="text-[10px] uppercase tracking-widest text-yellow-400 border border-yellow-800 rounded px-1.5 py-0.5">
                    manual
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-widest text-green-400 border border-green-900 rounded px-1.5 py-0.5">
                    auto
                  </span>
                )}
              </div>
              {serveManuallySet && (
                <button
                  data-testid="button-serve-reset"
                  onClick={() => setServeManuallySet(false)}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Reset to auto
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {/* P1 serve */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground truncate">{p1Name} serving</span>
                  <span className="text-xs text-muted-foreground">→ {p2Name} return: {Math.round(100 - p1ServePct)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="input-p1-serve-pct"
                    type="number"
                    min={50}
                    max={80}
                    value={Math.round(p1ServePct)}
                    onChange={(e) => {
                      setP1ServePct(clamp(Number(e.target.value), 50, 80));
                      setServeManuallySet(true);
                    }}
                    className="w-14 rounded border border-border bg-background px-2 py-1 text-sm font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                  <input
                    data-testid="slider-p1-serve-pct"
                    type="range"
                    min={50}
                    max={80}
                    value={Math.round(p1ServePct)}
                    onChange={(e) => {
                      setP1ServePct(Number(e.target.value));
                      setServeManuallySet(true);
                    }}
                    className="flex-1 accent-primary"
                  />
                </div>
              </div>
              {/* P2 serve */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground truncate">{p2Name} serving</span>
                  <span className="text-xs text-muted-foreground">→ {p1Name} return: {Math.round(100 - p2ServePct)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="input-p2-serve-pct"
                    type="number"
                    min={50}
                    max={80}
                    value={Math.round(p2ServePct)}
                    onChange={(e) => {
                      setP2ServePct(clamp(Number(e.target.value), 50, 80));
                      setServeManuallySet(true);
                    }}
                    className="w-14 rounded border border-border bg-background px-2 py-1 text-sm font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                  <input
                    data-testid="slider-p2-serve-pct"
                    type="range"
                    min={50}
                    max={80}
                    value={Math.round(p2ServePct)}
                    onChange={(e) => {
                      setP2ServePct(Number(e.target.value));
                      setServeManuallySet(true);
                    }}
                    className="flex-1 accent-primary"
                  />
                </div>
              </div>
            </div>
            {!serveManuallySet && (
              <div className="text-xs text-muted-foreground">
                Serve % auto-calibrated from pre-match probability · {tourType === "atp" ? "ATP" : "WTA"} baseline {tourBaseline}% · adjust sliders to override
              </div>
            )}
          </div>

          {/* Match format */}
          <div className="flex flex-wrap gap-6">
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Format</div>
              <div className="flex gap-2">
                {([3, 5] as const).map((n) => (
                  <button
                    key={n}
                    data-testid={`button-best-of-${n}`}
                    onClick={() => setBestOf(n)}
                    className={`px-3 py-1.5 rounded text-sm font-bold border transition-all ${
                      bestOf === n
                        ? "border-primary text-primary bg-primary/10"
                        : "border-border text-muted-foreground hover:border-muted-foreground"
                    }`}
                  >
                    Best of {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Final Set Rule</div>
              <div className="flex gap-2">
                <button
                  data-testid="button-match-tiebreak"
                  onClick={() => setFinalSetTiebreak(true)}
                  className={`px-3 py-1.5 rounded text-sm font-bold border transition-all ${
                    finalSetTiebreak
                      ? "border-primary text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  10-pt Match Tiebreak
                </button>
                <button
                  data-testid="button-full-set"
                  onClick={() => setFinalSetTiebreak(false)}
                  className={`px-3 py-1.5 rounded text-sm font-bold border transition-all ${
                    !finalSetTiebreak
                      ? "border-primary text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  Full Final Set
                </button>
              </div>
            </div>
          </div>

          {/* Score inputs */}
          <div className="space-y-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Current Score</div>

            {/* Sets */}
            <div className="grid grid-cols-2 gap-4">
              <NumberStepper value={p1Sets} onChange={setP1Sets} min={0} max={setsToWin - 1} label={`${p1Name} sets`} testId="p1-sets" />
              <NumberStepper value={p2Sets} onChange={setP2Sets} min={0} max={setsToWin - 1} label={`${p2Name} sets`} testId="p2-sets" />
            </div>

            {/* Completed set scores — shown when at least one set is done */}
            {completedSetScores.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Completed set scores (for game spread tracking)</div>
                <div className="flex flex-wrap gap-2">
                  {completedSetScores.map((s, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs">
                      <span className="text-muted-foreground">Set {idx + 1}:</span>
                      <input
                        data-testid={`input-set-score-p1-${idx}`}
                        type="number"
                        min={0}
                        max={7}
                        value={s.p1}
                        onChange={e => setCompletedSetScores(prev => {
                          const next = [...prev];
                          next[idx] = { ...next[idx], p1: Number(e.target.value) };
                          return next;
                        })}
                        className="w-8 text-center font-mono bg-transparent focus:outline-none focus:ring-1 focus:ring-primary rounded"
                      />
                      <span className="text-muted-foreground">–</span>
                      <input
                        data-testid={`input-set-score-p2-${idx}`}
                        type="number"
                        min={0}
                        max={7}
                        value={s.p2}
                        onChange={e => setCompletedSetScores(prev => {
                          const next = [...prev];
                          next[idx] = { ...next[idx], p2: Number(e.target.value) };
                          return next;
                        })}
                        className="w-8 text-center font-mono bg-transparent focus:outline-none focus:ring-1 focus:ring-primary rounded"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Games */}
            <div className="grid grid-cols-2 gap-4">
              <NumberStepper value={p1Games} onChange={setP1Games} min={0} max={7} label={`${p1Name} games`} testId="p1-games" />
              <NumberStepper value={p2Games} onChange={setP2Games} min={0} max={7} label={`${p2Name} games`} testId="p2-games" />
            </div>

            {/* Tiebreak toggle */}
            <div className="flex items-center gap-3">
              <button
                data-testid="button-tiebreak-toggle"
                onClick={() => setInTiebreak(!inTiebreak)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
                  inTiebreak ? "bg-primary border-primary" : "bg-secondary border-border"
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
                    inTiebreak ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
              <span className="text-sm text-muted-foreground">Tiebreak in progress</span>
            </div>

            {inTiebreak ? (
              <div className="grid grid-cols-2 gap-4">
                <NumberStepper value={p1TiebreakPoints} onChange={setP1TiebreakPoints} min={0} max={20} label={`${p1Name} TB pts`} testId="p1-tb" />
                <NumberStepper value={p2TiebreakPoints} onChange={setP2TiebreakPoints} min={0} max={20} label={`${p2Name} TB pts`} testId="p2-tb" />
              </div>
            ) : (
              /* Point score */
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">{p1Name} points</div>
                  <div className="flex gap-1">
                    {POINT_LABELS.map((label, idx) => (
                      <button
                        key={idx}
                        data-testid={`button-p1-points-${idx}`}
                        onClick={() => setP1Points(idx)}
                        className={`flex-1 py-1 rounded text-xs font-bold border transition-all ${
                          p1Points === idx
                            ? "border-primary text-primary bg-primary/10"
                            : "border-border text-muted-foreground hover:border-muted-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">{p2Name} points</div>
                  <div className="flex gap-1">
                    {POINT_LABELS.map((label, idx) => (
                      <button
                        key={idx}
                        data-testid={`button-p2-points-${idx}`}
                        onClick={() => setP2Points(idx)}
                        className={`flex-1 py-1 rounded text-xs font-bold border transition-all ${
                          p2Points === idx
                            ? "border-primary text-primary bg-primary/10"
                            : "border-border text-muted-foreground hover:border-muted-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Serving */}
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">Currently serving</div>
              <div className="flex gap-2">
                <button
                  data-testid="button-serving-p1"
                  onClick={() => setServing(1)}
                  className={`px-3 py-1.5 rounded text-sm font-bold border transition-all ${
                    serving === 1
                      ? "border-primary text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {p1Name}
                </button>
                <button
                  data-testid="button-serving-p2"
                  onClick={() => setServing(2)}
                  className={`px-3 py-1.5 rounded text-sm font-bold border transition-all ${
                    serving === 2
                      ? "border-primary text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {p2Name}
                </button>
              </div>
            </div>
          </div>

          {/* Score summary display */}
          <div className="rounded-lg bg-secondary border border-border p-3 font-mono text-sm flex items-center gap-3 flex-wrap">
            <span className="text-muted-foreground text-xs">Score:</span>
            <span data-testid="score-summary" className="font-bold">
              {p1Name}: {p1Sets} sets, {p1Games}-{p2Games} games
              {inTiebreak ? `, TB ${p1TiebreakPoints}-${p2TiebreakPoints}` : `, ${POINT_LABELS[p1Points]}-${POINT_LABELS[p2Points]}`}
            </span>
            <span className="text-muted-foreground text-xs">Serving:</span>
            <span className="font-bold text-primary">{serving === 1 ? p1Name : p2Name}</span>
          </div>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div data-testid="warnings" className="rounded-lg bg-yellow-950 border border-yellow-800 px-3 py-2 space-y-1">
              {warnings.map((w, i) => (
                <div key={i} className="text-xs text-yellow-400 flex items-start gap-1.5">
                  <span>⚠</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* === SECTION 3: Live Odds Output === */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Live Odds Output</div>
            <div className="text-xs text-muted-foreground">Updates instantly</div>
          </div>

          <ProbBar p1Prob={liveP1Prob} />

          <div className="flex gap-4">
            <OddsCard
              playerName={p1Name}
              prob={liveP1Prob}
              preMatchProb={preMatchP1}
              isP1={true}
            />
            <OddsCard
              playerName={p2Name}
              prob={liveP2Prob}
              preMatchProb={preMatchP2}
              isP1={false}
            />
          </div>

          {/* Reference row */}
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Pre-match probability (anchor)</div>
              <div className="flex gap-3 font-mono text-xs text-muted-foreground">
                <span>{p1Name}: {formatAmericanOdds(probToAmericanOdds(preMatchP1))} ({p1PrematchPct}%)</span>
              </div>
              <div className="flex gap-3 font-mono text-xs text-muted-foreground">
                <span>{p2Name}: {formatAmericanOdds(probToAmericanOdds(preMatchP2))} ({100 - p1PrematchPct}%)</span>
              </div>
              <div className="font-mono text-xs text-muted-foreground mt-1">
                Pre-game spread:&nbsp;
                {preMatchGameSpread >= 0
                  ? <span className="text-[hsl(82,100%,50%)]">{p1Name} +{preMatchGameSpread.toFixed(2)}</span>
                  : <span className="text-red-400">{p2Name} +{Math.abs(preMatchGameSpread).toFixed(2)}</span>
                }
                &nbsp;games
              </div>
              <div className="font-mono text-xs text-muted-foreground mt-0.5">
                Set 1:&nbsp;
                <span className="text-[hsl(82,100%,50%)]">{(set1WinPctNeutral * 100).toFixed(1)}%</span>
                &nbsp;/&nbsp;
                <span className="text-red-400">{((1 - set1WinPctNeutral) * 100).toFixed(1)}%</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Model implied pre-match</div>
              <div className="font-mono text-xs text-muted-foreground">
                {p1Name}: {(impliedPreMatchP1 * 100).toFixed(1)}% · {p2Name}: {((1 - impliedPreMatchP1) * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                iid · two-server · serve alternation exact · {bestOf === 3 ? "BO3" : "BO5"} · {finalSetTiebreak ? "10-pt final set TB" : "full final set"}
              </div>
            </div>
          </div>

          {/* Live set win % + spreads */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
            {/* Left: live set win % for current set + upcoming sets */}
            <div className="rounded-md bg-card border border-border px-3 py-2 space-y-2">
              {/* Current set */}
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  Live set {liveSetStats.currentSetNumber} win %
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-[hsl(82,100%,50%)]">{(liveSetStats.currentWinProb * 100).toFixed(1)}%</span>
                  <span className="text-red-400">{((1 - liveSetStats.currentWinProb) * 100).toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                  <span>{p1Name}</span>
                  <span>{liveSetStats.serverKnown ? `${firstServerThisSet === 1 ? p1Name : p2Name} serves first` : "server est."}</span>
                  <span>{p2Name}</span>
                </div>
              </div>
              {/* Upcoming sets (hidden when in final set) */}
              {liveSetStats.upcomingSets.map(({ setNum, winProb }) => (
                <div key={setNum} className="border-t border-border/40 pt-1.5">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                    Set {setNum} win % <span className="normal-case">(est.)</span>
                  </div>
                  <div className="flex justify-between font-mono text-sm">
                    <span className="text-[hsl(82,100%,50%)]">{(winProb * 100).toFixed(1)}%</span>
                    <span className="text-red-400">{((1 - winProb) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                    <span>{p1Name}</span><span>server neutral</span><span>{p2Name}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Right: live games spread + live sets spread */}
            <div className="rounded-md bg-card border border-border px-3 py-2 space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Live games spread</div>
                <div className="font-mono text-sm">
                  {liveGameSpread >= 0
                    ? <span className="text-[hsl(82,100%,50%)]">{p1Name} +{liveGameSpread.toFixed(2)}</span>
                    : <span className="text-red-400">{p2Name} +{Math.abs(liveGameSpread).toFixed(2)}</span>
                  }
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {completedSetScores.length > 0
                    ? `${completedSetScores.map(s => `${s.p1}–${s.p2}`).join(", ")} + expected remaining`
                    : "expected total match games"}
                </div>
              </div>
              <div className="border-t border-border/40 pt-1.5">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Live sets spread</div>
                <div className="font-mono text-sm">
                  {liveSetSpread >= 0
                    ? <span className="text-[hsl(82,100%,50%)]">{p1Name} +{liveSetSpread.toFixed(2)}</span>
                    : <span className="text-red-400">{p2Name} +{Math.abs(liveSetSpread).toFixed(2)}</span>
                  }
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">expected total sets margin</div>
              </div>
            </div>
          </div>
        </div>

        {/* === SECTION 4: Next-point scenarios === */}
        <ScenarioPanel
          label={`If ${p1Name} loses next point`}
          p1Name={p1Name}
          p2Name={p2Name}
          p1Prob={probIfP2WinsPoint}
          delta={probIfP2WinsPoint - liveP1Prob}
          testIdPrefix="scenario-p1-loses"
        />

        <ScenarioPanel
          label={`If ${p1Name} wins next point`}
          p1Name={p1Name}
          p2Name={p2Name}
          p1Prob={probIfP1WinsPoint}
          delta={probIfP1WinsPoint - liveP1Prob}
          testIdPrefix="scenario-p1-wins"
        />

      </div>
    </div>
  );
}

// ─── ScenarioPanel ─────────────────────────────────────────────────────────

function ScenarioPanel({
  label,
  p1Name,
  p2Name,
  p1Prob,
  delta,
  testIdPrefix,
}: {
  label: string;
  p1Name: string;
  p2Name: string;
  p1Prob: number;
  delta: number;
  testIdPrefix: string;
}) {
  const p2Prob = 1 - p1Prob;
  const sign = delta >= 0 ? "+" : "";
  const deltaColor = delta > 0.001
    ? "text-green-400"
    : delta < -0.001
    ? "text-red-400"
    : "text-muted-foreground";

  return (
    <div
      data-testid={testIdPrefix}
      className="rounded-xl border border-border bg-card p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </div>
        <div className={`text-xs font-mono font-bold ${deltaColor}`}>
          {p1Name} {sign}{(delta * 100).toFixed(1)}%
        </div>
      </div>

      <ProbBar p1Prob={p1Prob} />

      <div className="grid grid-cols-2 gap-3">
        <div
          data-testid={`${testIdPrefix}-p1`}
          className="rounded-lg bg-secondary border border-border p-3 space-y-0.5"
        >
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">{p1Name}</div>
          <div className="font-mono text-lg font-black tabular-nums" style={{ color: "hsl(82,100%,50%)" }}>
            {formatAmericanOdds(probToAmericanOdds(p1Prob))}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {probToDecimalOdds(p1Prob)} · {(p1Prob * 100).toFixed(1)}%
          </div>
        </div>
        <div
          data-testid={`${testIdPrefix}-p2`}
          className="rounded-lg bg-secondary border border-border p-3 space-y-0.5"
        >
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">{p2Name}</div>
          <div className="font-mono text-lg font-black tabular-nums text-foreground">
            {formatAmericanOdds(probToAmericanOdds(p2Prob))}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {probToDecimalOdds(p2Prob)} · {(p2Prob * 100).toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  );
}
