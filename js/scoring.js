// scoring.js — Golf Points scoring engine
// Pure functions, no DOM. Used by the app and the unit tests.
//
// Rules (per Pete's house rules, 2014-2026):
// - 1 point for each 9-hole win 1-5 strokes
// - +1 additional point if 9-hole win is 5+ strokes (so 5+ win = 2 points)
// - +1 additional point for 18-hole win (only when both played 18)
// - +1 additional point per eagle (winner of the eagle gets +1 vs each opponent)
// - Final round: ALL points doubled
// - Handicap rules vary by year:
//   2026: Jim gets +2 strokes off each 9 (raw - 2 used for comparison)
//   2024: USGA-style fractional — auto-calc not implemented, use stored points

(function (root) {
  "use strict";

  /**
   * Apply per-player, per-9 stroke handicap before comparison.
   * Returns an adjusted 9-hole score (number) or null.
   */
  function adjustedNine(rawNine, playerKey, houseRules) {
    if (rawNine == null) return null;
    if (!houseRules) return rawNine;
    if (playerKey === "jim" && houseRules.jimStrokesPerNine) {
      return rawNine - houseRules.jimStrokesPerNine;
    }
    return rawNine;
  }

  /**
   * Score a single 9-hole pairwise matchup.
   * Returns { winner: 'a'|'b'|'tie', points: { a: N, b: N } } where points are pre-doubling.
   * Margin source: adjusted scores.
   */
  function scoreNine(scoreA, scoreB) {
    if (scoreA == null || scoreB == null) {
      return { winner: null, points: { a: 0, b: 0 } };
    }
    const margin = scoreB - scoreA; // positive = a wins
    if (margin === 0) return { winner: "tie", points: { a: 0, b: 0 } };
    const winner = margin > 0 ? "a" : "b";
    const absMargin = Math.abs(margin);
    let pts = 1;
    if (absMargin >= 5) pts = 2;
    return {
      winner,
      points: winner === "a" ? { a: pts, b: 0 } : { a: 0, b: pts },
    };
  }

  /**
   * Score a head-to-head pair in a single event.
   * Inputs:
   *   a, b: { front9, back9, total18, eagle }
   *   houseRules: season-level rules (handicap, etc.)
   *   playedHoles: 9 or 18 (event-level)
   *   isFinalRound: boolean
   *   keys: { a: 'eric', b: 'pete' }
   * Returns: { aPts, bPts, breakdown: { front, back, eighteen, eagles, doubled } }
   */
  function scorePair(a, b, houseRules, playedHoles, isFinalRound, keys) {
    let aPts = 0;
    let bPts = 0;
    const breakdown = {
      front: null,
      back: null,
      eighteen: null,
      eagleA: 0,
      eagleB: 0,
      doubled: !!isFinalRound,
      carryover: 0,
      carryoverTo: null,
    };

    // Front 9
    const aF = adjustedNine(a.front9, keys.a, houseRules);
    const bF = adjustedNine(b.front9, keys.b, houseRules);
    let frontTied = false;
    if (aF != null && bF != null) {
      const r = scoreNine(aF, bF);
      aPts += r.points.a;
      bPts += r.points.b;
      breakdown.front = { aRaw: a.front9, bRaw: b.front9, aAdj: aF, bAdj: bF, ...r };
      if (r.winner === "tie") frontTied = true;
    }
    // Back 9
    const aB = adjustedNine(a.back9, keys.a, houseRules);
    const bB = adjustedNine(b.back9, keys.b, houseRules);
    if (aB != null && bB != null) {
      const r = scoreNine(aB, bB);
      aPts += r.points.a;
      bPts += r.points.b;
      breakdown.back = { aRaw: a.back9, bRaw: b.back9, aAdj: aB, bAdj: bB, ...r };

      // Carry-over rule: if the front 9 tied (and both played both 9s), the back-9
      // winner gets +1 carried over. If the back also ties, the carry is lost.
      if (frontTied && playedHoles === 18 && r.winner === "a") {
        aPts += 1;
        breakdown.carryover = 1;
        breakdown.carryoverTo = "a";
      } else if (frontTied && playedHoles === 18 && r.winner === "b") {
        bPts += 1;
        breakdown.carryover = 1;
        breakdown.carryoverTo = "b";
      }
    }

    // 18-hole bonus: only if both played both nines
    if (playedHoles === 18 && aF != null && aB != null && bF != null && bB != null) {
      const aTotal = aF + aB;
      const bTotal = bF + bB;
      if (aTotal !== bTotal) {
        const winnerOf18 = aTotal < bTotal ? "a" : "b";
        if (winnerOf18 === "a") aPts += 1;
        else bPts += 1;
        breakdown.eighteen = { aTotal, bTotal, winner: winnerOf18 };
      } else {
        breakdown.eighteen = { aTotal, bTotal, winner: "tie" };
      }
    }

    // Eagles: each eagle gives +1 to that player (vs every opponent)
    if (a.eagle) {
      aPts += 1;
      breakdown.eagleA = 1;
    }
    if (b.eagle) {
      bPts += 1;
      breakdown.eagleB = 1;
    }

    // Final round: double everything
    if (isFinalRound) {
      aPts *= 2;
      bPts *= 2;
    }

    return { aPts, bPts, breakdown };
  }

  /**
   * Determine if an event is "9-hole only" or "18-hole".
   * Returns 9 or 18.
   * Heuristic: if any player has front9 AND back9 -> 18. Else 9.
   */
  function detectHoles(event) {
    for (const key of Object.keys(event.players)) {
      const p = event.players[key];
      if (p.front9 != null && p.back9 != null) return 18;
    }
    return 9;
  }

  /**
   * Compute all pairwise points for an event.
   * Returns:
   *   { perPlayer: { eric: { vsPete: N, vsJim: N }, ... }, breakdowns: [...] }
   * Pairs only included when BOTH players played at least one nine.
   */
  function scoreEvent(event, houseRules) {
    const playedHoles = detectHoles(event);
    const playerKeys = Object.keys(event.players);
    const result = { perPlayer: {}, breakdowns: [] };

    // Init zero records
    for (const k of playerKeys) result.perPlayer[k] = {};

    for (let i = 0; i < playerKeys.length; i++) {
      for (let j = i + 1; j < playerKeys.length; j++) {
        const ka = playerKeys[i];
        const kb = playerKeys[j];
        const a = event.players[ka];
        const b = event.players[kb];
        // Skip if either player didn't play any nine
        const aPlayed = a.front9 != null || a.back9 != null;
        const bPlayed = b.front9 != null || b.back9 != null;
        if (!aPlayed || !bPlayed) continue;

        const r = scorePair(a, b, houseRules, playedHoles, !!event.isFinalRound, {
          a: ka,
          b: kb,
        });
        const oppKeyA = "vs" + capitalize(kb);
        const oppKeyB = "vs" + capitalize(ka);
        result.perPlayer[ka][oppKeyA] = r.aPts;
        result.perPlayer[kb][oppKeyB] = r.bPts;
        result.breakdowns.push({ a: ka, b: kb, ...r });
      }
    }
    return result;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * Validate an event's raw scores against rule "max hole score = par x 2".
   * This is per-hole; we only have nine totals, so we can't strictly enforce.
   * Stub: returns warnings array. Real check happens during entry on a per-hole basis if/when added.
   */
  function validateEvent(event) {
    return [];
  }

  // -------- Aggregations --------

  /**
   * Cumulative points per player per opponent across a season.
   * Returns: { eric: { vsPete: [{date, total}, ...], vsJim: [...] }, ... }
   */
  function cumulativeBySeason(season, useImported) {
    const events = (season.events || [])
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    const tally = {};
    for (const k of season.players) tally[k] = {};

    const out = {};
    for (const k of season.players) out[k] = {};

    for (const ev of events) {
      const evPts = useImported
        ? extractImportedPoints(ev)
        : scoreEvent(ev, season.houseRules).perPlayer;

      for (const playerKey of Object.keys(evPts)) {
        for (const oppKey of Object.keys(evPts[playerKey])) {
          tally[playerKey][oppKey] = (tally[playerKey][oppKey] || 0) + (evPts[playerKey][oppKey] || 0);
          if (!out[playerKey][oppKey]) out[playerKey][oppKey] = [];
          out[playerKey][oppKey].push({ date: ev.date, total: tally[playerKey][oppKey] });
        }
      }
    }
    return out;
  }

  /** Pull pointsImported off each event into the same shape as scoreEvent's perPlayer. */
  function extractImportedPoints(event) {
    const out = {};
    for (const k of Object.keys(event.players)) {
      out[k] = {};
      const pi = event.players[k].pointsImported || {};
      for (const opp of Object.keys(pi)) {
        out[k][opp] = pi[opp] || 0;
      }
    }
    return out;
  }

  /** Season totals (per player per opponent). */
  function totalsBySeason(season, useImported) {
    const out = {};
    for (const k of season.players) out[k] = {};
    for (const ev of season.events) {
      const evPts = useImported
        ? extractImportedPoints(ev)
        : scoreEvent(ev, season.houseRules).perPlayer;
      for (const pk of Object.keys(evPts)) {
        for (const ok of Object.keys(evPts[pk])) {
          out[pk][ok] = (out[pk][ok] || 0) + (evPts[pk][ok] || 0);
        }
      }
    }
    return out;
  }

  /** Combined points per player (sum over all opponents). */
  function combinedTotals(season, useImported) {
    const totals = totalsBySeason(season, useImported);
    const out = {};
    for (const k of Object.keys(totals)) {
      out[k] = Object.values(totals[k]).reduce((a, b) => a + (b || 0), 0);
    }
    return out;
  }

  /**
   * Title (season winner) determination.
   * - 2-player years: max combined wins; equal = tie shared between them.
   * - 3-player years: Eric-vs-Pete head-to-head decides the title (Eric, Pete, or tie),
   *   UNLESS Jim's combined points exceed every Eric/Pete title-holder's combined,
   *   in which case Jim takes the title outright.
   * Returns:
   *   titleHolders: array of player keys (length 1 = sole winner, 2 = tie, 3 = three-way tie)
   *   seasonWinner: legacy single-value (first of titleHolders, or "tie")
   *   totals, combined
   */
  function determineSeasonResult(season, useImported) {
    const totals = totalsBySeason(season, useImported);
    const combined = combinedTotals(season, useImported);
    const players = season.players || Object.keys(combined);

    let titleHolders;

    if (players.length === 2) {
      // Two-player season: pure max points
      const [a, b] = players;
      const va = combined[a] || 0;
      const vb = combined[b] || 0;
      if (va > vb) titleHolders = [a];
      else if (vb > va) titleHolders = [b];
      else if (va === 0 && vb === 0) titleHolders = [];
      else titleHolders = [a, b];
    } else if (totals.eric && totals.pete) {
      // 3-player: Eric-vs-Pete head-to-head decides, then Jim override
      const ep = (totals.eric && totals.eric.vsPete) || 0;
      const pe = (totals.pete && totals.pete.vsEric) || 0;
      if (ep > pe) titleHolders = ["eric"];
      else if (pe > ep) titleHolders = ["pete"];
      else titleHolders = ["eric", "pete"];

      if (totals.jim) {
        const jimComb = combined.jim || 0;
        const beatsAll = titleHolders.every((k) => jimComb > (combined[k] || 0));
        if (beatsAll) titleHolders = ["jim"];
      }
    } else {
      // Fallback: max combined
      const max = Math.max(...Object.values(combined));
      titleHolders = Object.keys(combined).filter((k) => combined[k] === max);
      if (max === 0) titleHolders = [];
    }

    const seasonWinner = titleHolders.length === 1 ? titleHolders[0]
                       : titleHolders.length > 1 ? "tie"
                       : null;

    // Pete-vs-Eric head-to-head (always reported when both exist)
    let titleEricPete = null;
    if (totals.eric && totals.pete) {
      const ep = totals.eric.vsPete || 0;
      const pe = totals.pete.vsEric || 0;
      if (ep > pe) titleEricPete = "eric";
      else if (pe > ep) titleEricPete = "pete";
      else titleEricPete = "tie";
    }

    return { seasonWinner, titleHolders, titleEricPete, totals, combined };
  }

  // ---- Export ----
  const api = {
    scoreNine,
    scorePair,
    scoreEvent,
    detectHoles,
    validateEvent,
    cumulativeBySeason,
    totalsBySeason,
    combinedTotals,
    determineSeasonResult,
    extractImportedPoints,
    adjustedNine,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GolfScoring = api;
  }
})(typeof window !== "undefined" ? window : this);
