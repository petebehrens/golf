// app.js — routing + view rendering
// Depends on: GolfScoring (scoring.js), GolfStorage (storage.js), Chart (chart.js CDN)

(function () {
  "use strict";

  const Scoring = window.GolfScoring;
  const Storage = window.GolfStorage;

  const PLAYER_NAMES = { eric: "Eric", pete: "Pete", jim: "Jim" };
  const PLAYER_COLORS = { eric: "#185fa5", pete: "#a32d2d", jim: "#3b6d11" };
  const PLAYER_ORDER = ["eric", "pete", "jim"];
  const TODAY = new Date().toISOString().slice(0, 10);
  // Short/non-standard courses excluded from Best 18 / Best 9 personal records.
  const SHORT_COURSES = new Set(["Stony Creek"]);

  const state = {
    data: null,
    sha: null,
    chartInstances: {},
  };

  // -------- Boot --------
  document.addEventListener("DOMContentLoaded", boot);

  async function boot() {
    setStatus("Loading data…");
    try {
      const { data, sha, source } = await Storage.fetchSeasons();
      state.data = data;
      state.sha = sha;
      Storage.setCache(data, sha);
      setStatus(sourceLabel(source));
    } catch (e) {
      setStatus("Could not load data — check Settings.", true);
      // Render an empty shell anyway
      state.data = emptyData();
    }

    window.addEventListener("hashchange", route);
    document.querySelectorAll("[data-route]").forEach((a) => {
      a.addEventListener("click", () => setTimeout(updateNav, 0));
    });

    // Show settings link only when PAT is configured (or path is direct)
    refreshAdminUI();

    if (!location.hash) location.hash = `#/seasons/${currentYear()}`;
    route();
  }

  function refreshAdminUI() {
    const showSettings = Storage.hasPat() || location.hash.startsWith("#/settings");
    const link = document.getElementById("settings-link");
    if (link) link.classList.toggle("hidden", !showSettings);
  }

  function isAdmin() { return Storage.hasPat(); }

  function emptyData() {
    return {
      version: 1,
      currentYear: new Date().getFullYear(),
      seasons: {},
      playerNames: PLAYER_NAMES,
      allYearsImported: [],
    };
  }

  function sourceLabel(s) {
    if (s === "static") return "Loaded from page";
    if (s === "api") return "Loaded from GitHub API";
    if (s === "cache") return "Loaded from cache (offline)";
    return "Loaded";
  }

  function setStatus(msg, isError) {
    const el = document.getElementById("data-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? "var(--danger)" : "";
  }

  function toast(msg, isError) {
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2900);
  }

  function currentYear() {
    if (state.data && state.data.currentYear) return state.data.currentYear;
    const today = new Date();
    return today.getFullYear();
  }

  // -------- Router --------
  function route() {
    const hash = location.hash.slice(1) || "/season";
    const [path, query] = hash.split("?");
    const parts = path.split("/").filter(Boolean);
    const section = parts[0] || "seasons";
    const params = parseQuery(query || "");

    updateNav(section);
    refreshAdminUI();

    // Public can't reach Settings without PAT or direct URL; reroute strangers away
    if (section === "settings" && !isAdmin() && !sessionStorage.getItem("golf.settingsAck")) {
      // First-time direct hit: allow once via session ack so PAT can be entered
      sessionStorage.setItem("golf.settingsAck", "1");
    }

    switch (section) {
      case "seasons":
      case "season":   // legacy redirect
        if (section === "season") { location.hash = `#/seasons${parts[1] ? "/" + parts[1] : "/" + currentYear()}`; return; }
        renderSeason(parts[1] ? Number(parts[1]) : currentYear());
        break;
      case "statistics":
        renderLifetime();
        break;
      case "lifetime":
        // Ambiguous: legacy Statistics used to live here. If second segment is a year, treat as Lifetime tab.
        // Otherwise, redirect old Statistics URL to /statistics.
        renderAllYears();
        break;
      case "all-years":   // legacy redirect
        location.hash = `#/lifetime`;
        return;
      case "settings":
        renderSettings();
        break;
      case "add":
        renderAddEvent({ pending: params.pending });
        break;
      case "edit":
        // #/edit/<year>/<eventId>
        if (!isAdmin()) { location.hash = `#/seasons/${parts[1] || currentYear()}`; return; }
        renderAddEvent({ year: Number(parts[1]), editEventId: parts.slice(2).join("/") });
        break;
      case "pending":
        renderPending(params.event);
        break;
      default:
        location.hash = `#/seasons/${currentYear()}`;
    }
  }

  function parseQuery(q) {
    const out = {};
    q.split("&").forEach((kv) => {
      if (!kv) return;
      const [k, v = ""] = kv.split("=");
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    });
    return out;
  }

  function updateNav(active) {
    document.querySelectorAll("[data-route]").forEach((a) => {
      a.classList.toggle("active", a.dataset.route === active);
    });
  }

  function mountTemplate(id) {
    const tpl = document.getElementById(id);
    const main = document.getElementById("app");
    main.innerHTML = "";
    main.appendChild(tpl.content.cloneNode(true));
    destroyCharts();
  }

  function destroyCharts() {
    Object.values(state.chartInstances).forEach((c) => {
      if (c && typeof c.destroy === "function") c.destroy();
    });
    state.chartInstances = {};
  }

  // ============================================================
  // SEASON VIEW
  // ============================================================
  function renderSeason(year) {
    mountTemplate("tpl-season");

    const yearKey = String(year);
    const season = (state.data.seasons || {})[yearKey] || emptySeason(year);

    // Year picker
    const picker = document.getElementById("year-picker");
    const years = Object.keys(state.data.seasons || {}).map(Number).sort((a, b) => b - a);
    if (!years.includes(year)) years.unshift(year);
    picker.innerHTML = years.map((y) => `<option value="${y}" ${y === year ? "selected" : ""}>${y}</option>`).join("");
    picker.addEventListener("change", () => location.hash = `#/seasons/${picker.value}`);

    // Meta
    const meta = document.getElementById("season-meta");
    const result = Scoring.determineSeasonResult(season, true);
    const playerNames = season.players.map((p) => PLAYER_NAMES[p]).join(" · ");
    let ruleNote = "";
    if (season.houseRules && season.houseRules.jimStrokesPerNine)
      ruleNote = ` · Jim +${season.houseRules.jimStrokesPerNine} handicap per nine holes`;
    if (season.houseRules && season.houseRules.handicap) ruleNote = " · USGA handicap";
    if (season.houseRules && season.houseRules.jimMagicEraser) ruleNote = " · Jim magic eraser";
    const winnerText = formatSeasonResult(result, season, year);
    meta.innerHTML = `<b>${playerNames}</b>${ruleNote} · ${season.events.length} rounds${winnerText}`;

    // Add round button — only for admin (PAT configured)
    const addBtn = document.getElementById("add-event-btn");
    if (isAdmin()) {
      addBtn.style.display = "";
      addBtn.addEventListener("click", () => {
        location.hash = `#/add?year=${year}`;
      });
    }

    // Standings (above chart)
    drawTotalsGrid(season, result);

    // Chart area: 1 chart for 2-player, 3 charts for 3-player
    drawSeasonChartArea(season);

    // Events table
    drawEventsTable(season);
  }

  function isPastSeason(year) {
    // A season is "past" if the year is less than current OR the current date is past Sept-end
    const today = new Date();
    if (year < today.getFullYear()) return true;
    // Same year: consider "past" only after Sept 30
    return year === today.getFullYear() && (today.getMonth() > 8 || (today.getMonth() === 8 && today.getDate() >= 30));
  }

  function formatSeasonResult(result, season, year) {
    if (!result || !season.events.length) return "";
    const past = isPastSeason(year);
    if (past) {
      const holders = result.titleHolders || [];
      if (holders.length === 0) return "";
      if (holders.length === 1) return ` · <b>${PLAYER_NAMES[holders[0]]}</b> won the season`;
      const names = holders.map((k) => PLAYER_NAMES[k]).join(" and ");
      return ` · Season ended in a tie · <b>${names}</b> share the title`;
    } else {
      // Current season: who's leading by W/T/L score. diffSum only breaks ordering,
      // never the rating - an equal score is a shared lead.
      const battle = computeBattlePositions(season, result);
      const rankedTop = season.players.slice().sort((a, b) => {
        if (battle[b].score !== battle[a].score) return battle[b].score - battle[a].score;
        return battle[b].diffSum - battle[a].diffSum;
      });
      const leader = rankedTop[0];
      if (!leader || battle[leader].wins === 0) return ` · Season just starting`;
      // Are there co-leaders at the top?
      const topGroup = season.players.filter((k) => battle[k].score === battle[leader].score);
      if (topGroup.length === 1) return ` · <b>${PLAYER_NAMES[leader]}</b> currently leads`;
      const names = topGroup.map((k) => PLAYER_NAMES[k]).join(" and ");
      return ` · <b>${names}</b> currently tied for the lead`;
    }
  }

  // Compute per-player wins/losses/ties + diffSum across all matchups in a season.
  function computeBattlePositions(season, result) {
    const totals = result.totals;
    const battle = {};
    for (const pk of season.players) {
      let wins = 0, losses = 0, ties = 0, diffSum = 0;
      for (const opp of season.players) {
        if (opp === pk) continue;
        const my = ((totals[pk] || {})["vs" + capitalize(opp)]) || 0;
        const their = ((totals[opp] || {})["vs" + capitalize(pk)]) || 0;
        const d = my - their;
        if (d > 0) wins++;
        else if (d < 0) losses++;
        else ties++;
        diffSum += d;
      }
      // Typical W/T/L scoring - a win is worth 1, a tie half, a loss nothing.
      // So 1-0-1 (a win and a tie) outranks 1-1-0 (a win and a loss).
      battle[pk] = { wins, losses, ties, diffSum, score: wins + ties * 0.5 };
    }
    return battle;
  }

  function emptySeason(year) {
    const players = year >= 2026 || (year >= 2021 && year !== 2024 && year !== 2025)
      ? ["eric", "pete", "jim"]
      : ["eric", "pete"];
    const houseRules = {};
    if (year === 2026) { houseRules.jimStrokesPerNine = 2; houseRules.format = "round-robin-pairs"; }
    return { year, players, houseRules, events: [] };
  }

  // Build the chart area: one chart for 2-player years, three pair charts for 3-player.
  function drawSeasonChartArea(season) {
    const wrap = document.getElementById("chart-area");
    const events = season.events.slice().sort((a, b) => a.date.localeCompare(b.date));

    if (season.players.length <= 2) {
      // Single chart, two lines
      const a = season.players[0];
      const b = season.players[1] || null;
      wrap.innerHTML = `<div class="chart-card"><canvas id="pair-chart-only"></canvas></div>`;
      drawPairChart("pair-chart-only", events, a, b, `${season.year} cumulative points`);
      return;
    }

    // 3-player: three pair charts (E vs P, E vs J, P vs J)
    const pairs = [
      ["eric", "pete"],
      ["eric", "jim"],
      ["pete", "jim"],
    ];
    wrap.innerHTML = `<div class="pair-charts three">${pairs.map(([a, b], i) => `
      <div class="pair-chart-wrap">
        <div class="pair-title">${PLAYER_NAMES[a]} vs ${PLAYER_NAMES[b]}</div>
        <div style="position:relative;height:180px"><canvas id="pair-chart-${i}"></canvas></div>
      </div>
    `).join("")}</div>`;
    pairs.forEach(([a, b], i) => drawPairChart(`pair-chart-${i}`, events, a, b, null));
  }

  function drawPairChart(canvasId, events, aKey, bKey, title) {
    const labels = events.map((e) => formatShortDate(e.date));
    const aOppKey = "vs" + capitalize(bKey);
    const bOppKey = "vs" + capitalize(aKey);
    const aSeries = []; const bSeries = [];
    let aTotal = 0, bTotal = 0;
    for (const ev of events) {
      const aPts = (ev.players[aKey] && ev.players[aKey].pointsImported && ev.players[aKey].pointsImported[aOppKey]) || 0;
      const bPts = (ev.players[bKey] && ev.players[bKey].pointsImported && ev.players[bKey].pointsImported[bOppKey]) || 0;
      aTotal += aPts; bTotal += bPts;
      aSeries.push(aTotal);
      bSeries.push(bTotal);
    }
    const datasets = [
      { label: PLAYER_NAMES[aKey], data: aSeries, borderColor: PLAYER_COLORS[aKey], backgroundColor: PLAYER_COLORS[aKey] + "22", tension: 0.2, borderWidth: 2.5, pointRadius: 2 },
      { label: PLAYER_NAMES[bKey], data: bSeries, borderColor: PLAYER_COLORS[bKey], backgroundColor: PLAYER_COLORS[bKey] + "22", tension: 0.2, borderWidth: 2.5, pointRadius: 2 },
    ];
    const ctx = document.getElementById(canvasId).getContext("2d");
    state.chartInstances[canvasId] = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 } } }, title: title ? { display: true, text: title } : { display: false } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
        },
      },
    });
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function drawTotalsGrid(season, result) {
    const grid = document.getElementById("totals-grid");
    const totals = result.totals;
    const combined = result.combined;

    const battle = computeBattlePositions(season, result);

    // Sort by W/T/L score desc, then differential sum desc, then combined pts.
    // (diffSum only orders the cards; players on the same score share a rating.)
    const sorted = season.players.slice().sort((a, b) => {
      if (battle[b].score !== battle[a].score) return battle[b].score - battle[a].score;
      if (battle[b].diffSum !== battle[a].diffSum) return battle[b].diffSum - battle[a].diffSum;
      return (combined[b] || 0) - (combined[a] || 0);
    });

    // Past seasons: crown title-holders. Current: crown by battle position.
    const past = isPastSeason(season.year);
    let crowned = new Set();
    if (past) {
      (result.titleHolders || []).forEach((k) => crowned.add(k));
    } else if (season.events.length) {
      const anyWin = season.players.some((k) => battle[k].wins > 0);
      const topScore = Math.max(...season.players.map((k) => battle[k].score));
      if (anyWin) season.players.filter((k) => battle[k].score === topScore).forEach((k) => crowned.add(k));
    }

    // Rank labels — each player's status (Winner/Middle/Loser or in-progress equivalents)
    // Past 3-player seasons defer to titleHolders so 2022's E-vs-P tie shows Co-Winner.
    const labels = rankLabels(season, battle, past, result.titleHolders);

    // If anyone has a tie, show W-L-T for everyone so the records compare cleanly
    // (a tie is what separates 1-0-1 from 1-1-0, so it has to be visible on both cards).
    const showTies = season.players.some((k) => battle[k].ties > 0);

    grid.innerHTML = sorted.map((pk) => {
      const isLead = crowned.has(pk);
      const b = battle[pk];
      const record = `${b.wins}-${b.losses}${showTies ? `-${b.ties}` : ""}`;
      const statusLabel = labels[pk] || "";
      const titleLine = statusLabel ? `${statusLabel} ${record}` : record;

      // Head-to-head split bars for each opponent
      const bars = season.players
        .filter((opp) => opp !== pk)
        .map((opp) => {
          const myPts = ((totals[pk] || {})["vs" + capitalize(opp)]) || 0;
          const oppPts = ((totals[opp] || {})["vs" + capitalize(pk)]) || 0;
          const total = myPts + oppPts;
          const myPct = total > 0 ? (myPts / total) * 100 : 50;
          const oppPct = 100 - myPct;
          return `
            <div class="h2h">
              <div class="h2h-label">
                <span class="h2h-me">${PLAYER_NAMES[pk]} ${formatPts(myPts)}</span>
                <span class="h2h-vs">vs ${PLAYER_NAMES[opp]}</span>
                <span class="h2h-them">${formatPts(oppPts)}</span>
              </div>
              <div class="h2h-bar">
                <div class="h2h-bar-me bar-${pk}" style="width: ${myPct}%"></div>
                <div class="h2h-bar-them bar-${opp}-soft" style="width: ${oppPct}%"></div>
              </div>
            </div>
          `;
        }).join("");

      return `
        <div class="player-card ${pk} ${isLead ? "lead" : ""}">
          <div class="name"><span class="dot"></span>${PLAYER_NAMES[pk]}</div>
          <div class="record">${titleLine}</div>
          <div class="h2h-list">${bars}</div>
          <div class="total-small">${formatPts(combined[pk] || 0)} pts total</div>
        </div>
      `;
    }).join("");
  }

  // Determine a status label per player: Winner/Co-Winner/Middle Child/Loser
  // (or Winning/Co-Winning/Middle Child/Losing for in-progress seasons).
  // Past 3-player seasons defer to titleHolders (which honors the E-vs-P head-to-head rule
  // — so a 38-38 draw shows as Co-Winner even if the diffSum leans one way).
  function rankLabels(season, battle, past, titleHolders) {
    const players = season.players;
    if (!players.length) return {};

    if (past) {
      const holders = titleHolders || [];
      const labels = {};
      if (holders.length === 0) return labels;   // no data
      if (holders.length === 1) {
        labels[holders[0]] = "Winner";
      } else {
        const label = players.length === 2 ? "Co-Winner" : "Co-Winner";
        for (const pk of holders) labels[pk] = label;
      }
      // Remaining players ranked by wins/diffSum for middle/loser distinction
      const remaining = players.filter((k) => !holders.includes(k));
      remaining.sort((a, b) => {
        if (battle[b].score !== battle[a].score) return battle[b].score - battle[a].score;
        return battle[b].diffSum - battle[a].diffSum;
      });
      if (remaining.length === 1) {
        labels[remaining[0]] = "Loser";
      } else if (remaining.length === 2) {
        // Sole holder + two non-holders → the better non-holder is Middle Child, worse is Loser
        // If both non-holders are tied, both are Co-Loser
        const [a, b] = remaining;
        if (battle[a].score === battle[b].score) {
          labels[a] = labels[b] = "Co-Loser";
        } else {
          labels[a] = "Meh";
          labels[b] = "Loser";
        }
      }
      return labels;
    }

    // In-progress: group into tiers by W/T/L score alone. Same score = same rating,
    // even if the point differential leans one way.
    const sorted = players.slice().sort((a, b) => {
      if (battle[b].score !== battle[a].score) return battle[b].score - battle[a].score;
      return battle[b].diffSum - battle[a].diffSum;
    });
    const tiers = [];
    for (const pk of sorted) {
      const tier = tiers[tiers.length - 1];
      const same = tier && tier.length && battle[pk].score === battle[tier[0]].score;
      if (same) tier.push(pk);
      else tiers.push([pk]);
    }
    const labels = {};
    const topTier = tiers[0] || [];
    const bottomTier = tiers.length > 1 ? tiers[tiers.length - 1] : [];
    const middleTiers = tiers.slice(1, -1);
    if (tiers.length === 1 && players.length > 1) {
      for (const pk of topTier) labels[pk] = "Tied";
      return labels;
    }
    if (topTier.length === 1) labels[topTier[0]] = "Winning";
    else for (const pk of topTier) labels[pk] = "Co-Winning";
    for (const tier of middleTiers) for (const pk of tier) labels[pk] = "Meh";
    if (bottomTier.length === 1) labels[bottomTier[0]] = "Losing";
    else if (bottomTier.length > 1) for (const pk of bottomTier) labels[pk] = "Co-Losing";
    return labels;
  }

  function drawEventsTable(season) {
    const wrap = document.getElementById("events-table");
    if (!season.events.length) {
      wrap.innerHTML = `<p class="muted">No rounds yet. Tap <b>+ Add Round</b> to start the season.</p>`;
      return;
    }
    const events = season.events.slice().sort((a, b) => b.date.localeCompare(a.date));

    if (season.players.length >= 3) {
      drawEventsTable3Player(season, events, wrap);
    } else {
      drawEventsTable2Player(season, events, wrap);
    }
  }

  // 2-player: one row per event, scores stacked, pills side by side. No wrapping.
  function drawEventsTable2Player(season, events, wrap) {
    const admin = isAdmin();
    const rows = events.map((ev) => {
      const badges = badgesFor(ev);
      const editIcon = admin ? editLink(season.year, ev.id) : "";
      const scoresLine = season.players.map((pk) => scoreLineFor(ev, pk)).join("");
      const ptsCells = season.players.map((pk) => {
        const p = ev.players[pk];
        if (!p || !played(p)) return `<span class="pts-empty"></span>`;
        const total = totalPtsFor(p);
        return `<span class="pts-${pk}">${formatPts(total)}</span>`;
      }).join(" ");
      return `
        <tr>
          <td class="col-date">${formatShortDate(ev.date)}</td>
          <td class="col-course">
            ${escapeHtml(ev.course)} ${badges} ${editIcon}
            ${ev.comments ? `<div class="comments">${escapeHtml(ev.comments)}</div>` : ""}
          </td>
          <td class="col-scores"><div class="scores">${scoresLine}</div></td>
          <td class="col-pts">${ptsCells}</td>
        </tr>
      `;
    }).join("");
    wrap.innerHTML = `
      <table class="events-list two-player">
        <thead>
          <tr>
            <th class="col-date">Date</th>
            <th class="col-course">Course</th>
            <th class="col-scores">Scores</th>
            <th class="col-pts">${season.players.map((p) => PLAYER_NAMES[p].charAt(0)).join(" · ")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // 3-player: each event spans multiple rows (one per player who actually played).
  // Each row shows one player's score and per-opponent points (in opponent's column).
  function drawEventsTable3Player(season, events, wrap) {
    const admin = isAdmin();
    const rowsHtml = [];
    for (const ev of events) {
      const playersInEv = season.players.filter((pk) => {
        const p = ev.players[pk];
        return p && (played(p) || (Object.values(p.pointsImported || {}).some((v) => v)));
      });
      if (!playersInEv.length) continue;

      const badges = badgesFor(ev);
      const editIcon = admin ? editLink(season.year, ev.id) : "";
      const courseBlock = `${escapeHtml(ev.course)} ${badges} ${editIcon}${ev.comments ? `<div class="comments">${escapeHtml(ev.comments)}</div>` : ""}`;

      let first = true;
      for (const pk of playersInEv) {
        const p = ev.players[pk];
        const cells = season.players.map((opp) => {
          if (opp === pk) return `<td class="col-pts diag">—</td>`;
          if (!playersInEv.includes(opp)) return `<td class="col-pts blank"></td>`;
          const pts = (p.pointsImported || {})["vs" + capitalize(opp)] || 0;
          return `<td class="col-pts"><span class="pts-${pk}">${formatPts(pts)}</span></td>`;
        }).join("");

        rowsHtml.push(`
          <tr class="ev-row ev-${pk} ${first ? "ev-first" : ""}">
            ${first ? `<td class="col-date" rowspan="${playersInEv.length}">${formatShortDate(ev.date)}</td>` : ""}
            ${first ? `<td class="col-course" rowspan="${playersInEv.length}">${courseBlock}</td>` : ""}
            <td class="col-scores">${scoreLineFor(ev, pk, /*inline=*/true)}</td>
            ${cells}
          </tr>
        `);
        first = false;
      }
    }

    wrap.innerHTML = `
      <table class="events-list three-player">
        <thead>
          <tr>
            <th class="col-date">Date</th>
            <th class="col-course">Course</th>
            <th class="col-scores">Score</th>
            ${season.players.map((p) =>
              `<th class="col-pts col-pts-${p}">${PLAYER_NAMES[p].charAt(0)}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody>${rowsHtml.join("")}</tbody>
      </table>
    `;
  }

  function badgesFor(ev) {
    const badges = [];
    if (ev.isFinalRound) badges.push(`<span class="badge final">Final ×2</span>`);
    if (ev.matchPlay) badges.push(`<span class="badge match">Match Play</span>`);
    if (ev.isPreseason) badges.push(`<span class="badge match">Preseason</span>`);
    return badges.join(" ");
  }
  function editLink(year, eventId) {
    return `<a class="edit-link" href="#/edit/${year}/${encodeURIComponent(eventId)}" title="Edit or delete">✎</a>`;
  }
  function played(p) {
    return p && (p.front9 != null || p.back9 != null);
  }
  function totalPtsFor(p) {
    return Object.values(p.pointsImported || {}).reduce((a, b) => a + (b || 0), 0);
  }
  function scoreLineFor(ev, pk, inline) {
    const p = ev.players[pk];
    if (!p) return "";
    const f = p.front9 != null ? p.front9 : "—";
    const b = p.back9 != null ? p.back9 : "—";
    const t = p.total18 != null
      ? ` = ${p.total18}`
      : (p.front9 != null && p.back9 != null ? ` = ${p.front9 + p.back9}` : "");
    const eagle = p.eagle ? ` 🦅` : "";
    if (inline) {
      return `<span class="who pl-${pk}">${PLAYER_NAMES[pk]}</span> ${f} / ${b}${t}${eagle}`;
    }
    return `<div class="score-line"><span class="who">${PLAYER_NAMES[pk]}</span>${f} / ${b}${t}${eagle}</div>`;
  }

  // ============================================================
  // LIFETIME VIEW
  // ============================================================
  function renderLifetime() {
    mountTemplate("tpl-lifetime");

    const rangeSelect = document.getElementById("range-picker");
    const customSpan = document.getElementById("custom-range");

    // Inject per-year options (latest first), between "All time" and "Custom"
    const years = Object.keys(state.data.seasons || {}).map(Number).sort((a, b) => b - a);
    const customOpt = rangeSelect.querySelector('option[value="custom"]');
    for (const y of years) {
      const opt = document.createElement("option");
      opt.value = `year-${y}`;
      opt.textContent = String(y);
      rangeSelect.insertBefore(opt, customOpt);
    }

    // Default to current year (fallback to All time if no data for it)
    const cy = currentYear();
    if (years.includes(cy)) rangeSelect.value = `year-${cy}`;

    const onChange = () => {
      customSpan.classList.toggle("hidden", rangeSelect.value !== "custom");
      redrawStatistics();
    };

    rangeSelect.addEventListener("change", onChange);
    document.getElementById("show-trend").addEventListener("change", redrawStatistics);
    document.getElementById("range-from").addEventListener("change", redrawStatistics);
    document.getElementById("range-to").addEventListener("change", redrawStatistics);
    document.querySelectorAll('.player-toggles input[data-player]').forEach((el) =>
      el.addEventListener("change", redrawStatistics));

    // Course filter — only show courses with 2+ rounds, alphabetical
    populateCourseFilter();
    document.getElementById("course-filter").addEventListener("change", redrawStatistics);

    redrawStatistics();
  }

  // Master re-render for the statistics view — chart + panels (order matches template)
  function redrawStatistics() {
    const filters = readStatsFilters();
    drawLifetimeChart(filters);
    drawIndividualStatsPanel(filters);
  }

  function readStatsFilters() {
    const rangeSelect = document.getElementById("range-picker");
    let from = null, to = null;
    const range = rangeSelect.value;
    if (range && range.startsWith("year-")) {
      const y = range.slice(5);
      from = `${y}-01-01`; to = `${y}-12-31`;
    } else if (range === "custom") {
      from = document.getElementById("range-from").value || null;
      to = document.getElementById("range-to").value || null;
    }
    const visible = {};
    document.querySelectorAll('.player-toggles input[data-player]').forEach((el) => {
      visible[el.dataset.player] = el.checked;
    });
    const course = document.getElementById("course-filter").value || null;
    return { from, to, visible, course, range };
  }

  // Iterate every event once, respecting range + course filters, calling cb(event, year).
  function forEachFilteredEvent(filters, cb) {
    for (const yKey of Object.keys(state.data.seasons || {})) {
      const season = state.data.seasons[yKey];
      for (const ev of season.events) {
        if (filters.from && ev.date < filters.from) continue;
        if (filters.to && ev.date > filters.to) continue;
        if (filters.course && (ev.course || "").trim() !== filters.course) continue;
        cb(ev, Number(yKey));
      }
    }
  }

  function full18For(p) {
    if (!p) return null;
    if (p.total18 != null) return p.total18;
    if (p.front9 != null && p.back9 != null) return p.front9 + p.back9;
    return null;
  }

  function populateCourseFilter() {
    const sel = document.getElementById("course-filter");
    if (!sel) return;
    const counts = allCoursesWithCounts();
    const list = Object.entries(counts)
      .filter(([_, n]) => n >= 2)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name, n] of list) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name} (${n})`;
      sel.appendChild(opt);
    }
  }

  function drawLifetimeChart(filters) {
    const select = document.getElementById("range-picker");
    if (!select) return; // route changed
    filters = filters || readStatsFilters();
    const { from, to, visible, course: courseFilter } = filters;

    // Collect every event from every season, with a per-player 18-equivalent score
    const points = { eric: [], pete: [], jim: [] };
    for (const yKey of Object.keys(state.data.seasons || {})) {
      const season = state.data.seasons[yKey];
      for (const ev of season.events) {
        if (from && ev.date < from) continue;
        if (to && ev.date > to) continue;
        if (courseFilter && (ev.course || "").trim() !== courseFilter) continue;
        for (const pk of Object.keys(ev.players)) {
          const p = ev.players[pk];
          let scoreFor18 = null;
          if (p.total18 != null) scoreFor18 = p.total18;
          else if (p.front9 != null && p.back9 != null) scoreFor18 = p.front9 + p.back9;
          else if (p.front9 != null) scoreFor18 = p.front9 * 2;
          else if (p.back9 != null) scoreFor18 = p.back9 * 2;
          if (scoreFor18 == null) continue;
          points[pk].push({ x: ev.date, y: scoreFor18 });
        }
      }
    }

    // Sort each by date
    for (const k of Object.keys(points)) points[k].sort((a, b) => a.x.localeCompare(b.x));

    const datasets = [];
    for (const pk of PLAYER_ORDER) {
      if (!points[pk].length) continue;
      if (visible[pk] === false) continue;
      datasets.push({
        label: PLAYER_NAMES[pk],
        data: points[pk],
        borderColor: PLAYER_COLORS[pk],
        backgroundColor: PLAYER_COLORS[pk] + "22",
        showLine: true,
        pointRadius: 2.5,
        borderWidth: 1.5,
        tension: 0.15,
      });

      // Trend line
      if (document.getElementById("show-trend").checked && points[pk].length > 2) {
        const trend = linearTrend(points[pk]);
        if (trend) {
          datasets.push({
            label: `${PLAYER_NAMES[pk]} trend`,
            data: trend,
            borderColor: PLAYER_COLORS[pk],
            borderDash: [6, 4],
            pointRadius: 0,
            showLine: true,
            tension: 0,
            borderWidth: 2,
          });
        }
      }
    }

    if (state.chartInstances.lifetime) state.chartInstances.lifetime.destroy();
    const ctx = document.getElementById("lifetime-chart").getContext("2d");
    state.chartInstances.lifetime = new Chart(ctx, {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          title: { display: true, text: "18-hole equivalent score over time (lower = better)" },
        },
        scales: {
          x: { type: "time", time: { unit: chooseTimeUnit(from, to), tooltipFormat: "MMM d, yyyy" } },
          y: { reverse: false, title: { display: true, text: "Score" } },
        },
      },
    });

  }

  function chooseTimeUnit(from, to) {
    if (!from || !to) return "year";
    const d1 = new Date(from); const d2 = new Date(to);
    const days = (d2 - d1) / (1000 * 60 * 60 * 24);
    if (days < 90) return "week";
    if (days < 365 * 1.5) return "month";
    return "year";
  }

  // ============================================================
  // STATISTICS PANELS
  // ============================================================

  // Panel: Individual statistics — per-player key stats card
  // Panel: Individual statistics — everything about each player in one column.
  // Layout uses subgrid so rows align across all cards for easy horizontal comparison.
  function drawIndividualStatsPanel(filters) {
    const wrap = document.querySelector("#stats-individual .stats-content");
    if (!wrap) return;
    const players = PLAYER_ORDER.filter((k) => filters.visible[k] !== false);

    // Compute overall round-winner streaks (across all filtered events, in date order).
    const events = [];
    forEachFilteredEvent(filters, (ev) => events.push(ev));
    events.sort((a, b) => a.date.localeCompare(b.date));

    const longestStreak = {};
    for (const pk of players) longestStreak[pk] = 0;
    const currentStreak = {};
    for (const pk of players) currentStreak[pk] = 0;

    for (const ev of events) {
      const totals = {};
      let anyoneScored = false;
      for (const pk of players) {
        const p = ev.players[pk];
        if (!p || (p.front9 == null && p.back9 == null)) continue;
        anyoneScored = true;
        const pi = p.pointsImported || {};
        let sum = 0;
        for (const v of Object.values(pi)) sum += v || 0;
        totals[pk] = sum;
      }
      if (!anyoneScored) continue;
      const max = Math.max(...Object.values(totals));
      const winners = Object.keys(totals).filter((k) => totals[k] === max);
      if (winners.length === 1) {
        const w = winners[0];
        for (const pk of players) {
          if (pk === w) {
            currentStreak[pk]++;
            if (currentStreak[pk] > longestStreak[pk]) longestStreak[pk] = currentStreak[pk];
          } else {
            currentStreak[pk] = 0;
          }
        }
      } else {
        for (const pk of players) currentStreak[pk] = 0;
      }
    }

    // Per-player: gather 18-hole totals, 9-hole-only scores, front & back 9 lists.
    const data = {};
    for (const pk of players) data[pk] = { total18: [], nine: [], front: [], back: [], best18: null, best9: null };
    forEachFilteredEvent(filters, (ev) => {
      const isShort = SHORT_COURSES.has((ev.course || "").trim());
      for (const pk of players) {
        const p = ev.players[pk];
        if (!p) continue;
        const hasF = p.front9 != null, hasB = p.back9 != null;
        if (hasF && hasB) {
          const t = full18For(p);
          if (t != null) {
            data[pk].total18.push(t);
            if (!isShort && (data[pk].best18 == null || t < data[pk].best18.score)) {
              data[pk].best18 = { score: t, date: ev.date, course: ev.course };
            }
          }
          data[pk].front.push(p.front9);
          data[pk].back.push(p.back9);
        } else if (hasF || hasB) {
          const s = hasF ? p.front9 : p.back9;
          data[pk].nine.push(s);
          if (!isShort && (data[pk].best9 == null || s < data[pk].best9.score)) {
            data[pk].best9 = { score: s, date: ev.date, course: ev.course, which: hasF ? "F9" : "B9" };
          }
          if (hasF) data[pk].front.push(p.front9);
          if (hasB) data[pk].back.push(p.back9);
        }
      }
    });

    const anyData = players.some((pk) => data[pk].total18.length > 0 || data[pk].nine.length > 0);
    if (!anyData) { wrap.innerHTML = `<p class="muted small">No data in this range.</p>`; return; }

    // Distribution bins
    const bins18 = [
      { label: "<80", min: 0, max: 79 },
      { label: "80-84", min: 80, max: 84 },
      { label: "85-89", min: 85, max: 89 },
      { label: "90-94", min: 90, max: 94 },
      { label: "95-99", min: 95, max: 99 },
      { label: "100+", min: 100, max: 9999 },
    ];
    const bins9 = [
      { label: "<40", min: 0, max: 39 },
      { label: "40-42", min: 40, max: 42 },
      { label: "43-45", min: 43, max: 45 },
      { label: "46-48", min: 46, max: 48 },
      { label: "49-51", min: 49, max: 51 },
      { label: "52+", min: 52, max: 999 },
    ];
    const distMax18 = Math.max(1, ...players.flatMap((pk) => bins18.map((b) => data[pk].total18.filter((s) => s >= b.min && s <= b.max).length)));
    const distMax9 = Math.max(1, ...players.flatMap((pk) => bins9.map((b) => data[pk].nine.filter((s) => s >= b.min && s <= b.max).length)));

    function fmt(n) { return n == null ? "—" : (typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : String(n)); }
    function stddev(arr) {
      if (!arr.length) return null;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
    }
    function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

    function distHtml(bins, arr, pk, maxN) {
      return bins.map((b) => {
        const n = arr.filter((s) => s >= b.min && s <= b.max).length;
        const h = maxN ? Math.max(2, (n / maxN) * 26) : 2;
        return `<div class="dist-bin"><div class="dist-bar bar-${pk}" style="height:${h}px" title="${b.label}: ${n}"></div><div class="dist-count">${n}</div><div class="dist-blabel muted">${b.label}</div></div>`;
      }).join("");
    }

    // Hide players with no rounds at all in the filtered range
    const withData = players.filter((pk) => data[pk].total18.length > 0 || data[pk].nine.length > 0);

    wrap.innerHTML = `<div class="individual-grid">${withData.map((pk) => {
      const s = data[pk];
      const avg18 = mean(s.total18);
      const avg9 = mean(s.nine);
      const std18 = stddev(s.total18);
      const std9 = stddev(s.nine);
      const front = mean(s.front);
      const back = mean(s.back);
      const streak = longestStreak[pk] || 0;

      const avg18Txt = s.total18.length ? `<b>${fmt(avg18)}</b> <span class="muted small">${s.total18.length} rounds</span>` : "—";
      const avg9Txt  = s.nine.length ? `<b>${fmt(avg9)}</b> <span class="muted small">${s.nine.length} rounds</span>` : "—";
      const best18Txt = s.best18 ? `<b>${s.best18.score}</b> <span class="muted small">${escapeHtml(s.best18.course || "")}</span>` : "—";
      const best9Txt  = s.best9  ? `<b>${s.best9.score}</b> <span class="muted small">${escapeHtml(s.best9.course || "")}</span>` : "—";
      const streakTxt = `<b>${streak}</b> <span class="muted small">${streak === 1 ? "round" : "rounds"}</span>`;
      const frontTxt = front != null ? `<b>${fmt(front)}</b>` : "—";
      let backTxt;
      if (back == null) backTxt = "—";
      else if (front == null) backTxt = `<b>${fmt(back)}</b>`;
      else {
        const diff = back - front;
        const sign = diff > 0 ? "+" : "";
        const diffTxt = diff === 0 ? "even" : `${sign}${fmt(diff)} diff`;
        backTxt = `<b>${fmt(back)}</b> <span class="muted small">${diffTxt}</span>`;
      }
      const std18Txt = std18 != null ? `<b>${fmt(std18)}</b> <span class="muted small">stddev</span>` : "—";
      const std9Txt = std9 != null ? `<b>${fmt(std9)}</b> <span class="muted small">stddev</span>` : "—";

      return `
        <div class="individual-card player-card ${pk}">
          <div class="ind-name">${PLAYER_NAMES[pk]}</div>

          <div class="ind-lbl">Average 18</div><div class="ind-val">${avg18Txt}</div>
          <div class="ind-lbl">Best 18</div><div class="ind-val">${best18Txt}</div>
          <div class="ind-sep"></div>

          <div class="ind-lbl">Average 9</div><div class="ind-val">${avg9Txt}</div>
          <div class="ind-lbl">Best 9</div><div class="ind-val">${best9Txt}</div>
          <div class="ind-sep"></div>

          <div class="ind-lbl">Front 9 avg</div><div class="ind-val">${frontTxt}</div>
          <div class="ind-lbl">Back 9 avg</div><div class="ind-val">${backTxt}</div>
          <div class="ind-sep"></div>

          <div class="ind-lbl">Longest Win Streak</div><div class="ind-val">${streakTxt}</div>
          <div class="ind-sep"></div>

          <div class="ind-lbl">18-hole distribution</div><div class="ind-val">${std18Txt}</div>
          <div class="ind-chart">${distHtml(bins18, s.total18, pk, distMax18)}</div>

          <div class="ind-gap"></div>

          <div class="ind-lbl">9-hole distribution</div><div class="ind-val">${std9Txt}</div>
          <div class="ind-chart">${distHtml(bins9, s.nine, pk, distMax9)}</div>
        </div>
      `;
    }).join("")}</div>`;
  }


  function linearTrend(points) {
    if (points.length < 2) return null;
    const x = points.map((p) => new Date(p.x).getTime());
    const y = points.map((p) => p.y);
    const n = x.length;
    const xMean = x.reduce((a, b) => a + b, 0) / n;
    const yMean = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i] - xMean) * (y[i] - yMean);
      den += (x[i] - xMean) * (x[i] - xMean);
    }
    if (den === 0) return null;
    const m = num / den;
    const c = yMean - m * xMean;
    return [
      { x: points[0].x, y: m * x[0] + c },
      { x: points[points.length - 1].x, y: m * x[n - 1] + c },
    ];
  }

  function isoDateMinusYears(d, n) {
    const t = new Date(d);
    t.setFullYear(t.getFullYear() - n);
    return t.toISOString().slice(0, 10);
  }

  // ============================================================
  // ALL YEARS VIEW
  // ============================================================
  function renderAllYears() {
    mountTemplate("tpl-all-years");

    const summaries = computeAllYearsSummaries();
    // Title tally per player + tie years — render as 4 cards above the table
    const perPlayerYears = { eric: [], pete: [], jim: [] };
    const tieYears = [];
    for (const s of summaries) {
      const holders = s.titleHolders || [];
      if (!holders.length) continue;
      for (const k of holders) {
        if (perPlayerYears[k]) perPlayerYears[k].push(s.year);
      }
      if (holders.length > 1) tieYears.push(s.year);
    }
    const fmtYears = (arr) => arr.length ? arr.join(", ") : "—";
    document.getElementById("title-card").innerHTML = `
      <div class="lt-card player-card eric">
        <div class="lt-name">Eric</div>
        <div class="lt-count">${perPlayerYears.eric.length}</div>
        <div class="lt-label muted">${perPlayerYears.eric.length === 1 ? "title" : "titles"}</div>
        <div class="lt-years muted small">${fmtYears(perPlayerYears.eric)}</div>
      </div>
      <div class="lt-card player-card pete">
        <div class="lt-name">Pete</div>
        <div class="lt-count">${perPlayerYears.pete.length}</div>
        <div class="lt-label muted">${perPlayerYears.pete.length === 1 ? "title" : "titles"}</div>
        <div class="lt-years muted small">${fmtYears(perPlayerYears.pete)}</div>
      </div>
      <div class="lt-card player-card jim">
        <div class="lt-name">Jim</div>
        <div class="lt-count">${perPlayerYears.jim.length}</div>
        <div class="lt-label muted">${perPlayerYears.jim.length === 1 ? "title" : "titles"}</div>
        <div class="lt-years muted small">${fmtYears(perPlayerYears.jim)}</div>
      </div>
      <div class="lt-card lt-tie">
        <div class="lt-name">Ties</div>
        <div class="lt-count">${tieYears.length}</div>
        <div class="lt-label muted">${tieYears.length === 1 ? "year" : "years"}</div>
        <div class="lt-years muted small">${fmtYears(tieYears)}</div>
      </div>
    `;

    // Rows sorted latest → oldest
    const fmtPlayer = (p) => p
      ? `<span class="ly-avg">${p.avg != null ? p.avg.toFixed(1) : "—"}<span class="muted small"> avg</span></span> <span class="ly-pts">${formatPts(p.points)}<span class="muted small"> pts</span></span>`
      : `<span class="muted">—</span>`;
    const rows = summaries.slice().sort((a, b) => b.year - a.year).map((s) => {
      const winnerKey = s.winnerKey || "tie";
      return `
        <tr>
          <td>${s.year}</td>
          <td><span class="winner-${winnerKey}">${s.winnerLabel}</span></td>
          <td class="ly-cell pl-eric">${fmtPlayer(s.perPlayer.eric)}</td>
          <td class="ly-cell pl-pete">${fmtPlayer(s.perPlayer.pete)}</td>
          <td class="ly-cell pl-jim">${fmtPlayer(s.perPlayer.jim)}</td>
          <td class="ly-notes">${s.notes || ""}</td>
        </tr>
      `;
    }).join("");
    document.getElementById("all-years-table").innerHTML = `
      <table class="all-years-table compact">
        <thead>
          <tr>
            <th>Year</th>
            <th>Winner</th>
            <th class="pl-eric">Eric</th>
            <th class="pl-pete">Pete</th>
            <th class="pl-jim">Jim</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function computeAllYearsSummaries() {
    const out = [];
    const years = Object.keys(state.data.seasons || {}).map(Number).sort((a, b) => a - b);
    for (const y of years) {
      const season = state.data.seasons[String(y)];
      const result = Scoring.determineSeasonResult(season, true);
      const combined = result.combined;

      // Per-player: avg 18-hole score + total points scored across all matchups
      const perPlayer = { eric: null, pete: null, jim: null };
      for (const pk of ["eric", "pete", "jim"]) {
        const scores = [];
        let points = 0;
        let rounds = 0;
        for (const ev of (season.events || [])) {
          const p = ev.players[pk];
          if (!p) continue;
          const played = (p.front9 != null || p.back9 != null);
          if (!played) continue;
          rounds++;
          const t = (p.total18 != null) ? p.total18
                   : (p.front9 != null && p.back9 != null) ? p.front9 + p.back9
                   : null;
          if (t != null) scores.push(t);
          const pi = p.pointsImported || {};
          for (const v of Object.values(pi)) points += (v || 0);
        }
        if (rounds > 0) {
          const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
          perPlayer[pk] = { avg, points, rounds };
        }
      }

      // Season winner (past seasons only)
      let winnerKey = null;
      let winnerLabel = "—";
      const past = isPastSeason(y);
      const holders = result.titleHolders || [];
      if (past && holders.length) {
        if (holders.length === 1) {
          winnerKey = holders[0];
          winnerLabel = PLAYER_NAMES[holders[0]];
        } else {
          winnerKey = "tie";
          winnerLabel = `Tie (${holders.map((k) => PLAYER_NAMES[k]).join(" & ")})`;
        }
      }

      out.push({
        year: y,
        perPlayer,
        winnerKey,
        winnerLabel,
        titleHolders: past ? holders : [],
        notes: (season.houseRules && season.houseRules.handicap) ? "Handicap" :
               (season.houseRules && season.houseRules.jimMagicEraser) ? "Jim eraser" :
               (season.houseRules && season.houseRules.jimStrokesPerNine) ? `Jim +${season.houseRules.jimStrokesPerNine}/9` : "",
      });
    }
    return out;
  }

  // Title = season win. In a tie, every tied player counts as having a (shared) title.
  function aggregateTitles(summaries) {
    let eric = 0, pete = 0, jim = 0, tie = 0;
    for (const s of summaries) {
      const holders = s.titleHolders || [];
      if (!holders.length) continue;
      if (holders.length > 1) tie++;
      for (const k of holders) {
        if (k === "eric") eric++;
        else if (k === "pete") pete++;
        else if (k === "jim") jim++;
      }
    }
    return { eric, pete, jim, tie };
  }

  // ============================================================
  // ADD EVENT VIEW
  // ============================================================
  // Collect canonical course names and their round-counts across every season.
  function allCoursesWithCounts() {
    const counts = {};
    for (const s of Object.values(state.data.seasons || {})) {
      for (const ev of s.events || []) {
        const c = (ev.course || "").trim();
        if (!c) continue;
        counts[c] = (counts[c] || 0) + 1;
      }
    }
    return counts;
  }

  function populateCourseDatalist() {
    const dl = document.getElementById("course-list");
    if (!dl) return;
    const counts = allCoursesWithCounts();
    const names = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    dl.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
  }

  function renderAddEvent(opts) {
    opts = opts || {};
    mountTemplate("tpl-add-event");
    const params = parseQuery((location.hash.split("?")[1]) || "");
    const year = opts.year || (params.year ? Number(params.year) : currentYear());
    const season = state.data.seasons[String(year)] || emptySeason(year);

    // Edit mode: find the existing event
    const editId = opts.editEventId || null;
    let existing = null;
    if (editId) {
      existing = (season.events || []).find((e) => e.id === editId);
      if (!existing) {
        toast("Round not found — it may have been deleted", true);
        location.hash = `#/seasons/${year}`;
        return;
      }
    }

    const form = document.getElementById("event-form");

    // Populate course datalist first (before prefill so datalist is available)
    populateCourseDatalist();

    // Render player rows
    renderPlayerRows(season);

    // Retitle + rebutton for edit mode + inject a Delete button
    if (existing) {
      const title = document.getElementById("add-title");
      if (title) title.textContent = "Edit Round";
      const submitBtn = document.getElementById("submit-btn");
      if (submitBtn) submitBtn.textContent = "Save Changes";
      // Inject a Delete button
      const actions = document.querySelector(".add-event-view .actions");
      if (actions && !document.getElementById("delete-btn")) {
        const del = document.createElement("button");
        del.type = "button";
        del.id = "delete-btn";
        del.className = "btn danger";
        del.textContent = "Delete";
        del.style.marginRight = "auto";
        actions.insertBefore(del, actions.firstChild);
        del.addEventListener("click", async () => {
          if (!confirm(`Delete ${existing.date} ${existing.course}?\n\nThis cannot be undone.`)) return;
          try {
            await deleteEvent(year, editId);
            toast("Round deleted");
            location.hash = `#/seasons/${year}`;
          } catch (e) {
            console.error(e);
            toast("Delete failed: " + (e.message || e), true);
          }
        });
      }
    }

    // Default or prefilled values
    if (existing) {
      form.elements.date.value = existing.date;
      form.elements.course.value = existing.course || "";
      form.elements.comments.value = existing.comments || "";
      form.elements.isFinalRound.checked = !!existing.isFinalRound;
      // Derive holes from which nines have data
      const anyFront = Object.values(existing.players).some((p) => p.front9 != null);
      const anyBack = Object.values(existing.players).some((p) => p.back9 != null);
      form.elements.holes.value = (anyFront && anyBack) ? "18" : (anyBack ? "back9" : "front9");
      // Prefill each player's scores
      for (const pk of season.players) {
        const p = existing.players[pk] || {};
        if (p.front9 != null && form.elements[`${pk}_front9`]) form.elements[`${pk}_front9`].value = p.front9;
        if (p.back9 != null && form.elements[`${pk}_back9`]) form.elements[`${pk}_back9`].value = p.back9;
        if (p.eagle && form.elements[`${pk}_eagle`]) form.elements[`${pk}_eagle`].checked = true;
        if (p.handicap != null && form.elements[`${pk}_handicap`]) form.elements[`${pk}_handicap`].value = p.handicap;
      }
    } else {
      form.elements.date.value = new Date().toISOString().slice(0, 10);
    }

    // Holes change → toggle 18 input visibility
    form.elements.holes.addEventListener("change", () => {
      togglePlayerInputs(form.elements.holes.value);
      updatePreview(season);
    });
    togglePlayerInputs(form.elements.holes.value);

    // Live preview
    form.addEventListener("input", () => updatePreview(season));
    if (existing) updatePreview(season);   // seed the preview after prefill

    // Actions
    document.getElementById("cancel-btn").addEventListener("click", () => {
      location.hash = `#/seasons/${year}`;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const event = formToEvent(form, season);

      // At least 2 players must have scored (you need a head-to-head matchup).
      const playedKeys = season.players.filter((pk) => {
        const p = event.players[pk];
        return p && (p.front9 != null || p.back9 != null);
      });
      if (playedKeys.length < 2) {
        toast(`Need scores for at least 2 players`, true);
        return;
      }
      for (const pk of season.players) {
        if (!playedKeys.includes(pk)) delete event.players[pk];
      }

      const errs = Scoring.validateEvent(event);
      if (errs.length) { toast(errs[0], true); return; }

      // Score it: stash imported points so display matches engine
      const calc = Scoring.scoreEvent(event, season.houseRules || {}).perPlayer;
      for (const pk of Object.keys(event.players)) {
        event.players[pk].pointsImported = calc[pk] || {};
      }

      // Preserve id + adjustment flag on edits
      if (existing) {
        event.id = existing.id;
        if (existing.scoreAdjusted) event.scoreAdjusted = true;
      }

      if (!Storage.hasPat()) {
        const suggestUrl = location.origin + location.pathname + `#/pending?event=${Storage.encodeSuggestion({ year, event })}`;
        await suggestEvent(suggestUrl, event);
        return;
      }

      try {
        await saveEvent(year, event, existing ? existing.id : null);
        toast(existing ? "Round updated" : "Round saved");
        location.hash = `#/seasons/${year}`;
      } catch (e) {
        console.error(e);
        toast("Save failed: " + (e.message || e), true);
      }
    });
  }

  function renderPlayerRows(season) {
    const wrap = document.getElementById("player-rows");
    wrap.innerHTML = season.players.map((pk) => `
      <div class="player-row ${pk}">
        <div class="player-name">${PLAYER_NAMES[pk]} <span class="muted small">— leave blank if didn't play</span></div>
        <div class="scores-row">
          <label data-front-label>Front 9 <input type="number" step="1" min="0" name="${pk}_front9" inputmode="numeric" /></label>
          <label data-back-label>Back 9 <input type="number" step="1" min="0" name="${pk}_back9" inputmode="numeric" /></label>
          <label class="check"><input type="checkbox" name="${pk}_eagle" /> Eagle</label>
          <label data-only-handicap class="check muted small" style="display:none">
            <input type="number" step="0.1" name="${pk}_handicap" placeholder="HC" style="width: 60px" />
          </label>
        </div>
      </div>
    `).join("");
    if (season.houseRules && season.houseRules.handicap) {
      wrap.querySelectorAll("[data-only-handicap]").forEach((el) => (el.style.display = ""));
    }
  }

  // Holes select is one of "front9" (9-hole front), "back9" (9-hole back), "18" (full).
  // Each player has two input fields (front9, back9). We just toggle which are visible.
  function togglePlayerInputs(holes) {
    const wrap = document.getElementById("player-rows");
    const showFront = (holes === "front9" || holes === "18");
    const showBack  = (holes === "back9"  || holes === "18");
    wrap.querySelectorAll("[data-front-label]").forEach((el) => {
      el.style.display = showFront ? "" : "none";
    });
    wrap.querySelectorAll("[data-back-label]").forEach((el) => {
      el.style.display = showBack ? "" : "none";
    });
  }

  function formToEvent(form, season) {
    const fd = new FormData(form);
    const holes = fd.get("holes"); // "front9" | "back9" | "18"
    const players = {};
    for (const pk of season.players) {
      let front9 = null, back9 = null;
      if (holes === "18") {
        front9 = numOrNull(fd.get(`${pk}_front9`));
        back9 = numOrNull(fd.get(`${pk}_back9`));
      } else if (holes === "back9") {
        back9 = numOrNull(fd.get(`${pk}_back9`));
      } else {
        front9 = numOrNull(fd.get(`${pk}_front9`));
      }
      const eagle = !!fd.get(`${pk}_eagle`);
      const handicap = numOrNull(fd.get(`${pk}_handicap`));
      const total18 = (front9 != null && back9 != null) ? front9 + back9 : null;
      players[pk] = { front9, back9, total18, eagle, handicap, magicEraser: null, pointsImported: {} };
    }
    const date = fd.get("date");
    const course = fd.get("course") || "";
    const slug = course.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    return {
      id: `${date}-${slug || "round"}-${Math.random().toString(36).slice(2, 6)}`,
      date,
      course,
      isFinalRound: !!fd.get("isFinalRound"),
      isPreseason: false,
      comments: fd.get("comments") || "",
      players,
    };
  }

  function numOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  }

  function updatePreview(season) {
    const form = document.getElementById("event-form");
    const event = formToEvent(form, season);
    const result = Scoring.scoreEvent(event, season.houseRules || {});
    const lines = [];
    for (const b of result.breakdowns) {
      const aPts = b.aPts;
      const bPts = b.bPts;
      const txt = [];
      if (b.breakdown.front) {
        const fr = b.breakdown.front;
        txt.push(`F9 ${PLAYER_NAMES[b.a]} ${fr.aAdj}${fr.aRaw !== fr.aAdj ? ` (${fr.aRaw}-${fr.aRaw - fr.aAdj})` : ""} vs ${PLAYER_NAMES[b.b]} ${fr.bAdj}${fr.bRaw !== fr.bAdj ? ` (${fr.bRaw}-${fr.bRaw - fr.bAdj})` : ""} → ${winText(fr, b.a, b.b)}`);
      }
      if (b.breakdown.back) {
        const ba = b.breakdown.back;
        txt.push(`B9 ${PLAYER_NAMES[b.a]} ${ba.aAdj} vs ${PLAYER_NAMES[b.b]} ${ba.bAdj} → ${winText(ba, b.a, b.b)}`);
      }
      if (b.breakdown.eighteen) {
        const e = b.breakdown.eighteen;
        if (e.winner === "tie") txt.push(`18: tie`);
        else txt.push(`18 winner ${e.winner === "a" ? PLAYER_NAMES[b.a] : PLAYER_NAMES[b.b]} → +1`);
      }
      if (b.breakdown.carryover) {
        const who = b.breakdown.carryoverTo === "a" ? PLAYER_NAMES[b.a] : PLAYER_NAMES[b.b];
        txt.push(`Front 9 tied → carryover +1 to ${who}`);
      }
      if (b.breakdown.eagleA) txt.push(`${PLAYER_NAMES[b.a]} eagle → +1`);
      if (b.breakdown.eagleB) txt.push(`${PLAYER_NAMES[b.b]} eagle → +1`);
      if (b.breakdown.doubled) txt.push(`Final round → ×2`);

      lines.push(`<div class="pp-line"><span class="pp-pts">${PLAYER_NAMES[b.a]} ${aPts} · ${PLAYER_NAMES[b.b]} ${bPts}</span></div><div class="pp-detail">${txt.join(" · ") || "Need scores"}</div>`);
    }
    document.getElementById("preview-content").innerHTML = lines.length ? `<div class="preview-content">${lines.join("")}</div>` : "Enter scores to see points calculation.";
  }

  function winText(nine, aKey, bKey) {
    if (nine.winner === "tie") return "tie";
    const winner = nine.winner === "a" ? aKey : bKey;
    const margin = Math.abs(nine.aAdj - nine.bAdj);
    const pts = nine.points.a || nine.points.b;
    return `${PLAYER_NAMES[winner]} +${margin} → +${pts}`;
  }

  async function saveEvent(year, event, replaceId) {
    const data = JSON.parse(JSON.stringify(state.data));
    if (!data.seasons[String(year)]) data.seasons[String(year)] = emptySeason(year);
    const season = data.seasons[String(year)];
    let msg;
    if (replaceId) {
      const idx = season.events.findIndex((e) => e.id === replaceId);
      if (idx >= 0) {
        season.events[idx] = event;
        msg = `Edit round: ${event.date} ${event.course}`;
      } else {
        // Fell through — the round we intended to replace is gone. Append instead.
        season.events.push(event);
        msg = `Add round: ${event.date} ${event.course}`;
      }
    } else {
      season.events.push(event);
      msg = `Add round: ${event.date} ${event.course}`;
    }
    season.events.sort((a, b) => a.date.localeCompare(b.date));
    data.lastUpdated = new Date().toISOString();
    const result = await Storage.saveSeasons(data, state.sha, msg);
    state.data = data;
    state.sha = result.sha;
    Storage.setCache(data, result.sha);
  }

  async function deleteEvent(year, eventId) {
    const data = JSON.parse(JSON.stringify(state.data));
    const season = data.seasons[String(year)];
    if (!season) throw new Error("Season not found");
    const idx = season.events.findIndex((e) => e.id === eventId);
    if (idx < 0) throw new Error("Round not found — already deleted?");
    const removed = season.events[idx];
    season.events.splice(idx, 1);
    data.lastUpdated = new Date().toISOString();
    const result = await Storage.saveSeasons(data, state.sha, `Delete round: ${removed.date} ${removed.course}`);
    state.data = data;
    state.sha = result.sha;
    Storage.setCache(data, result.sha);
  }

  async function suggestEvent(url, event) {
    // Try Web Share API on iOS / Android
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Golf round to approve",
          text: `${event.date} · ${event.course}`,
          url,
        });
        toast("Sent to Pete");
        return;
      }
    } catch (e) { /* user canceled, fall through */ }
    // Fallback: copy URL to clipboard
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied — text it to Pete");
    } catch {
      prompt("Copy this URL and send to Pete:", url);
    }
  }

  // ============================================================
  // PENDING (approve a suggested round)
  // ============================================================
  function renderPending(b64) {
    mountTemplate("tpl-pending");
    let payload;
    try {
      payload = Storage.decodeSuggestion(b64);
    } catch (e) {
      document.getElementById("pending-preview").innerHTML = `<p class="muted">Could not parse suggestion.</p>`;
      return;
    }
    const { year, event } = payload;
    const season = state.data.seasons[String(year)] || emptySeason(year);
    const calc = Scoring.scoreEvent(event, season.houseRules || {});
    const html = [];
    html.push(`<p><b>${event.date}</b> · ${escapeHtml(event.course)}${event.isFinalRound ? ' <span class="badge final">Final ×2</span>' : ""}</p>`);
    for (const pk of Object.keys(event.players)) {
      const p = event.players[pk];
      html.push(`<div><b>${PLAYER_NAMES[pk]}</b> · ${p.front9 ?? "—"} / ${p.back9 ?? "—"}${p.eagle ? " 🦅" : ""}</div>`);
    }
    if (calc.breakdowns.length) {
      html.push(`<h4 style="margin-top:8px">Calculated points</h4>`);
      for (const b of calc.breakdowns) {
        html.push(`<div>${PLAYER_NAMES[b.a]} ${b.aPts} · ${PLAYER_NAMES[b.b]} ${b.bPts}</div>`);
      }
    }
    if (event.comments) html.push(`<p class="muted small">${escapeHtml(event.comments)}</p>`);
    document.getElementById("pending-preview").innerHTML = html.join("");

    document.getElementById("reject-btn").addEventListener("click", () => {
      location.hash = `#/seasons/${year}`;
    });
    document.getElementById("approve-btn").addEventListener("click", async () => {
      try {
        // Re-score and stash points before saving (avoid trusting payload's calc)
        const calc2 = Scoring.scoreEvent(event, season.houseRules || {}).perPlayer;
        for (const pk of Object.keys(event.players)) {
          event.players[pk].pointsImported = calc2[pk] || {};
        }
        await saveEvent(year, event);
        toast("Round saved");
        location.hash = `#/seasons/${year}`;
      } catch (e) {
        console.error(e);
        toast("Save failed: " + (e.message || e), true);
      }
    });
  }

  // ============================================================
  // SETTINGS VIEW
  // ============================================================
  function renderSettings() {
    mountTemplate("tpl-settings");

    const repo = Storage.getRepo();
    document.getElementById("repo-owner").value = repo.owner;
    document.getElementById("repo-name").value = repo.repo;
    document.getElementById("repo-path").value = repo.path;
    document.getElementById("repo-branch").value = repo.branch;
    document.getElementById("pat-status").textContent = Storage.hasPat()
      ? "PAT is configured on this device. (Not shown.)"
      : "No PAT configured. You're in read-only / suggest mode.";

    document.getElementById("save-pat").addEventListener("click", () => {
      const v = document.getElementById("pat-input").value.trim();
      Storage.setPat(v);
      document.getElementById("pat-input").value = "";
      document.getElementById("pat-status").textContent = v
        ? "PAT saved on this device."
        : "PAT cleared.";
      toast(v ? "PAT saved" : "PAT cleared");
    });

    document.getElementById("save-repo").addEventListener("click", () => {
      Storage.setRepo({
        owner: document.getElementById("repo-owner").value.trim(),
        repo: document.getElementById("repo-name").value.trim(),
        path: document.getElementById("repo-path").value.trim(),
        branch: document.getElementById("repo-branch").value.trim() || "main",
      });
      toast("Repo config saved");
    });

    document.getElementById("test-fetch").addEventListener("click", async () => {
      try {
        const { sha } = await Storage.fetchViaApi();
        toast(`OK · sha ${sha.slice(0, 7)}`);
      } catch (e) {
        toast("Failed: " + (e.message || e), true);
      }
    });

    document.getElementById("reload-btn").addEventListener("click", async () => {
      try {
        const { data, sha } = await Storage.fetchSeasons();
        state.data = data; state.sha = sha;
        Storage.setCache(data, sha);
        toast("Reloaded");
      } catch (e) {
        toast("Reload failed: " + (e.message || e), true);
      }
    });

    document.getElementById("export-json").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "seasons.json"; a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("export-xlsx").addEventListener("click", () => exportXlsx());

    document.getElementById("import-btn").addEventListener("click", () => {
      const txt = document.getElementById("import-text").value.trim();
      if (!txt) return toast("Paste JSON first", true);
      try {
        const obj = JSON.parse(txt);
        if (!obj.seasons) throw new Error("Missing 'seasons' field");
        state.data = obj;
        Storage.setCache(obj, state.sha);
        toast("Imported into local cache. Reload from repo to sync, or use Save to persist.");
      } catch (e) {
        toast("Invalid JSON: " + e.message, true);
      }
    });
  }

  async function exportXlsx() {
    // Lazy-load SheetJS only when needed
    if (!window.XLSX) {
      await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    }
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();

    // One sheet per season
    for (const yKey of Object.keys(state.data.seasons).sort()) {
      const s = state.data.seasons[yKey];
      const cols = ["Date", "Course", "Holes", "Final"];
      for (const pk of s.players) {
        cols.push(`${PLAYER_NAMES[pk]} F9`, `${PLAYER_NAMES[pk]} B9`, `${PLAYER_NAMES[pk]} 18`, `${PLAYER_NAMES[pk]} Eagle`);
      }
      for (const pk of s.players) {
        for (const opp of s.players) {
          if (opp === pk) continue;
          cols.push(`${PLAYER_NAMES[pk]} pts vs ${PLAYER_NAMES[opp].charAt(0)}`);
        }
      }
      cols.push("Comments");

      const rows = [cols];
      for (const ev of s.events) {
        const row = [ev.date, ev.course, ev.players[s.players[0]] && ev.players[s.players[0]].back9 != null ? 18 : 9, ev.isFinalRound ? "Y" : ""];
        for (const pk of s.players) {
          const p = ev.players[pk] || {};
          row.push(p.front9, p.back9, p.total18, p.eagle ? "Y" : "");
        }
        for (const pk of s.players) {
          for (const opp of s.players) {
            if (opp === pk) continue;
            const oppKey = "vs" + opp.charAt(0).toUpperCase() + opp.slice(1);
            row.push((ev.players[pk] && ev.players[pk].pointsImported && ev.players[pk].pointsImported[oppKey]) || 0);
          }
        }
        row.push(ev.comments || "");
        rows.push(row);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, yKey);
    }

    // All Years summary sheet
    const summaries = computeAllYearsSummaries();
    const ayRows = [["Year", "Season Winner", "Eric vs P", "Pete vs E", "Jim vs E/P", "Title", "Notes"]];
    for (const s of summaries) ayRows.push([s.year, s.winnerLabel, s.eric, s.pete, s.jim, s.titleResult, s.notes]);
    const ayWs = XLSX.utils.aoa_to_sheet(ayRows);
    XLSX.utils.book_append_sheet(wb, ayWs, "All Years");

    XLSX.writeFile(wb, `golf-seasons-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ============================================================
  // helpers
  // ============================================================
  function formatShortDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m) - 1]} ${parseInt(d)}`;
  }
  function formatPts(n) {
    if (n == null) return "0";
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return n.toFixed(1);
  }
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
