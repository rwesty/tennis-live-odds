import { Router, type IRouter } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router: IRouter = Router();

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface MatchResult {
  status: "live" | "finished" | "not_started";
  p1Name: string;
  p2Name: string;
  sets: Array<[number, number]>;
  p1Games: number;
  p2Games: number;
  p1Points: number;
  p2Points: number;
  serving: 1 | 2 | null;
  inTiebreak: boolean;
  p1TiebreakPoints: number;
  p2TiebreakPoints: number;
}

/**
 * Extract match ID from a FlashScore URL.
 * Priority order:
 *   1. ?mid= query param (most reliable — browser sets it explicitly)
 *   2. /match/sport/MATCHID/ path pattern
 *   3. Last hyphen-segment in the first slug of /game/sport/slug-ID/
 *   4. Generic 8-char alphanumeric path segment
 */
function extractMatchId(url: string): string | null {
  // 1. ?mid= query param
  try {
    const mid = new URL(url).searchParams.get("mid");
    if (mid && /^[A-Za-z0-9]{6,12}$/.test(mid)) return mid;
  } catch {
    // fall through
  }

  // 2. /match/sport/MATCHID/
  const matchRoute = url.match(/\/match\/[^/]+\/([A-Za-z0-9]{6,12})(?:\/|$)/);
  if (matchRoute) return matchRoute[1];

  // 3. /game/sport/slug-MATCHID/ — ID is the last hyphen-separated segment of the first path slug
  const gameRoute = url.match(/\/game\/[^/]+\/[^/]*-([A-Za-z0-9]{6,10})(?:\/|$)/);
  if (gameRoute) return gameRoute[1];

  // 4. Generic 8-char segment
  const generic = url.match(/\/([A-Za-z0-9]{8})(?:\/|$)/);
  if (generic) return generic[1];

  return null;
}

/**
 * Parse the ¬-delimited FlashScore data feed.
 * Each record is "KEY÷VALUE" separated by ¬.
 *
 * Known fields confirmed from live match (dc_1_ feed type):
 *   DL   = status: 3=live, 0/1=not_started, ≥100=finished
 *   DN   = P1 games in current set
 *   DO   = P2 games in current set
 *   DQ   = P1 current point (0/15/30/40/50=AD)
 *   DP   = P2 current point (0/15/30/40/50=AD)
 *   DV   = serving player (1=P1, 2=P2)
 *   DS,DE = completed set 1 scores (P1, P2) — non-zero once a set is done
 *   DF,DG = completed set 2 scores
 *   DH,DI = completed set 3 scores
 */
function parseFeed(raw: string): {
  status: "live" | "finished" | "not_started";
  sets: Array<[number, number]>;
  p1Games: number;
  p2Games: number;
  p1Points: number;
  p2Points: number;
  serving: 1 | 2 | null;
} | null {
  const fields: Record<string, string> = {};

  // Records are separated by ¬; each record is KEY÷VALUE
  for (const record of raw.split("¬")) {
    const divIdx = record.indexOf("÷");
    if (divIdx < 1) continue;
    const key = record.slice(0, divIdx).replace(/[^A-Za-z0-9]/g, "");
    const val = record.slice(divIdx + 1);
    if (key) fields[key] = val;
  }

  if (Object.keys(fields).length < 3) return null;

  // Status — DL: 3=live, 0/1/6=not_started, ≥100=finished
  const dlRaw = parseInt(fields["DL"] ?? "-1", 10);
  let status: "live" | "finished" | "not_started" = "not_started";
  if (dlRaw > 1 && dlRaw < 100) {
    status = "live";
  } else if (dlRaw >= 100) {
    status = "finished";
  }

  // Sets won: DF = away/P2 sets won, DG = home/P1 sets won.
  // (DS/DE are always 0 in the dc_1_ feed and not useful; DH/DI duplicate DF/DG with a -1 sentinel.)
  // We don't get individual set game scores from this feed, so we generate synthetic
  // [1,0] / [0,1] markers — enough for the UI to count who leads in sets.
  const p2SetsWon = parseInt(fields["DF"] ?? "0", 10) || 0;
  const p1SetsWon = parseInt(fields["DG"] ?? "0", 10) || 0;
  const sets: Array<[number, number]> = [];
  for (let i = 0; i < p1SetsWon; i++) sets.push([1, 0]);
  for (let i = 0; i < p2SetsWon; i++) sets.push([0, 1]);

  // Current set games: DN=P1, DO=P2
  const p1Games = parseInt(fields["DN"] ?? "0", 10) || 0;
  const p2Games = parseInt(fields["DO"] ?? "0", 10) || 0;

  // Current point: DQ=P1, DP=P2 — FlashScore sends 0/15/30/40/50(=AD) as raw tennis scores
  const pointMap: Record<number, number> = { 0: 0, 15: 1, 30: 2, 40: 3, 50: 4 };
  const rawP1Pt = parseInt(fields["DQ"] ?? "0", 10);
  const rawP2Pt = parseInt(fields["DP"] ?? "0", 10);
  const p1Points = pointMap[rawP1Pt] ?? 0;
  const p2Points = pointMap[rawP2Pt] ?? 0;

  // Serving: DV=1 means P1, DV=2 means P2
  let serving: 1 | 2 | null = null;
  const dvVal = fields["DV"] ?? fields["DR"] ?? "";
  if (dvVal === "1") serving = 1;
  else if (dvVal === "2") serving = 2;

  return { status, sets, p1Games, p2Games, p1Points, p2Points, serving };
}

/**
 * Parse player names + any available scores from the HTML page.
 * FlashScore is JS-rendered so live scores aren't in the source, but
 * the <title> tag always contains "Player1 v Player2 DATE | Tennis".
 */
function parseHtml(html: string): { p1Name: string; p2Name: string; status: "live" | "finished" | "not_started" } {
  const $ = cheerio.load(html);

  let p1Name = "Player 1";
  let p2Name = "Player 2";

  // <title> is server-rendered and always present: "P1 v P2 DD/MM/YYYY | Sport - Flashscore"
  const titleText = $("title").first().text().trim();
  const titleMatch = titleText.match(/^(.+?)\s+v\s+(.+?)\s+\d{2}\/\d{2}\/\d{4}/i)
    ?? titleText.match(/^(.+?)\s+-\s+(.+?)[\s|]/);
  if (titleMatch) {
    p1Name = titleMatch[1].trim();
    p2Name = titleMatch[2].trim();
  } else {
    // og:title fallback: "P1 - P2"
    const ogTitle = $('meta[property="og:title"]').attr("content") ?? "";
    const ogMatch = ogTitle.match(/^(.+?)\s+-\s+(.+)$/);
    if (ogMatch) {
      p1Name = ogMatch[1].trim();
      p2Name = ogMatch[2].trim();
    }
  }

  // Status from inline scripts (usually not present in static HTML, but worth trying)
  let status: "live" | "finished" | "not_started" = "not_started";
  const lower = html.toLowerCase();
  if (lower.includes("inprogress") || lower.includes('"statustype":"live"')) status = "live";
  else if (lower.includes("finished") || lower.includes("st_100")) status = "finished";

  return { p1Name, p2Name, status };
}

router.get("/score", async (req, res) => {
  const url = req.query["url"] as string | undefined;
  if (!url || !/^https?:\/\//.test(url)) {
    res.status(400).json({ error: "A valid url query param is required." });
    return;
  }

  const matchId = extractMatchId(url);
  req.log.info({ matchId, url }, "score fetch started");

  // Always fetch HTML for player names (title tag is server-rendered)
  let p1Name = "Player 1";
  let p2Name = "Player 2";
  let htmlStatus: "live" | "finished" | "not_started" = "not_started";

  try {
    const htmlRes = await axios.get<string>(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 10000,
      responseType: "text",
    });
    const parsed = parseHtml(htmlRes.data as string);
    p1Name = parsed.p1Name;
    p2Name = parsed.p2Name;
    htmlStatus = parsed.status;
  } catch (err) {
    req.log.warn({ err }, "HTML fetch failed");
  }

  // ── FlashScore data feed for live status + scores ───────────────────────
  // Uses 130.flashscore.ninja/2/x/feed/ — requires full browser CORS headers.
  if (matchId) {
    try {
      const feedUrl = `https://130.flashscore.ninja/2/x/feed/dc_1_${matchId}`;
      const feedRes = await axios.get<string>(feedUrl, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Referer": "https://www.flashscore.com/",
          "Origin": "https://www.flashscore.com",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "x-fsign": "SW9D1eZo",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "cross-site",
          "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
        timeout: 8000,
        responseType: "text",
        decompress: true,
      });

      const feedData = parseFeed(feedRes.data as string);
      if (feedData) {
        req.log.info({ source: "feed", status: feedData.status }, "score fetched");
        const result: MatchResult = {
          status: feedData.status,
          p1Name,
          p2Name,
          sets: feedData.sets,
          p1Games: feedData.p1Games,
          p2Games: feedData.p2Games,
          p1Points: feedData.p1Points,
          p2Points: feedData.p2Points,
          serving: feedData.serving,
          inTiebreak: false,
          p1TiebreakPoints: 0,
          p2TiebreakPoints: 0,
        };
        res.json(result);
        return;
      }
    } catch (err) {
      req.log.warn({ err }, "feed fetch failed, falling back to HTML status");
    }
  }

  // ── Fallback: return what we got from HTML ───────────────────────────────
  req.log.info({ source: "html-only" }, "score fetched");
  const result: MatchResult = {
    status: htmlStatus,
    p1Name,
    p2Name,
    sets: [],
    p1Games: 0,
    p2Games: 0,
    p1Points: 0,
    p2Points: 0,
    serving: null,
    inTiebreak: false,
    p1TiebreakPoints: 0,
    p2TiebreakPoints: 0,
  };
  res.json(result);
});

export default router;
