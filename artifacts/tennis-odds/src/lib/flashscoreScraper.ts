export interface ScrapedMatch {
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
  raw?: string;
}

export async function scrapeMatch(url: string): Promise<ScrapedMatch> {
  const encoded = encodeURIComponent(url);
  let res: Response;
  try {
    res = await fetch(`/api/score?url=${encoded}`, {
      signal: AbortSignal.timeout(18000),
    });
  } catch (e) {
    throw new Error(`Network error contacting score server: ${(e as Error).message}. Use manual entry.`);
  }

  if (!res.ok) {
    let msg = `Server returned ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore parse failure
    }
    throw new Error(`${msg}. Use manual entry.`);
  }

  const data = await res.json() as ScrapedMatch;
  return data;
}

function parsePointScore(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (s === "0") return 0;
  if (s === "15") return 1;
  if (s === "30") return 2;
  if (s === "40") return 3;
  if (s === "a" || s === "ad" || s === "adv" || s === "advantage") return 4;
  const n = parseInt(s, 10);
  if (!isNaN(n)) return Math.min(n, 4);
  return 0;
}

export { parsePointScore };
