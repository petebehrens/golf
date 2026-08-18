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

    if (!location.hash) location.hash = `#/season/${currentYear()}`;
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
    const section = parts[0] || "season";
    const params = parseQuery(query || "");

    updateNav(section);
    refreshAdminUI();

    // Public can't reach Settings without PAT or direct URL; reroute strangers away
    if (section === "settings" && !isAdmin() && !sessionStorage.getItem("golf.settingsAck")) {
      // First-time direct hit: allow once via session ack so PAT can be entered
      sessionStorage.setItem("golf.settingsAck", "1");
    }

    switch (section) {
      case "season":
        renderSeason(parts[1] ? Number(parts[1]) : currentYear());
        break;
      case "lifetime":
        renderLifetime();
        break;
      case "all-years":
        renderAllYears();
        break;
      case "settings":
        renderSettings();
        break;
      case "add":
        renderAddEvent({ pending: params.pending });
        break;
      case "edit":
        // #/edit/<year>/<eventId>
        if (!isAdmin()) { location.hash = `#/season/${parts[1] || currentYear()}`; return; }
        renderAddEvent({ year: Number(parts[1]), editEventId: parts.slice(2).join("/") });
        break;
      case "pending":
        renderPending(params.event);
        break;
      default:
        location.hash = `#/season/${currentYear()}`;
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
    picker.addEventListener("change", () => location.hash = `#/season/${picker.value}`);

    // Meta
    const meta = document.getElementById("season-meta");
    const result = Scoring.determineSeasonResult(season, true);
    const playerNames = season.players.map((p) => PLAYER_NAMES[p]).join(" · ");
    let ruleNote = "";
    if (season.houseRules && season.houseRules.jimStrokesPerNine)
      ruleNote = ` · Jim +${season.houseRules.jimStrokesPerNine}/9`;
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
      // Current season: who's leading by combined right now
      const combined = result.combined || {};
      const max = Math.max(...Object.values(combined));
      if (max === 0) return ` · Season just starting`;
      const top = Object.keys(combined).filter((k) => combined[k] === max);
      if (top.length === 1) return ` · <b>${PLAYER_NAMES[top[0]]}</b> currently leads`;
      return ` · Currently <b>tied</b>`;
    }
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

    // Compute per-player battle record: wins/losses/ties across each pairing,
    // plus the sum of differentials (for tiebreak).
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
      battle[pk] = { wins, losses, ties, diffSum };
    }

    // Sort by battle record: wins desc, then differential sum desc, then combined pts.
    const sorted = season.players.slice().sort((a, b) => {
      if (battle[b].wins !== battle[a].wins) return battle[b].wins - battle[a].wins;
      if (battle[b].diffSum !== battle[a].diffSum) return battle[b].diffSum - battle[a].diffSum;
      return (combined[b] || 0) - (combined[a] || 0);
    });

    // Past seasons: crown title-holders. Current: crown by battle position.
    const past = isPastSeason(season.year);
    let crowned = new Set();
    if (past) {
      (result.titleHolders || []).forEach((k) => crowned.add(k));
    } else if (season.events.length) {
      // Sole leader in wins AND differential gets the crown
      const topWins = Math.max(...season.players.map((k) => battle[k].wins));
      const topByWins = season.players.filter((k) => battle[k].wins === topWins);
      if (topByWins.length === 1 && topWins > 0) {
        crowned.add(topByWins[0]);
      }
    }

    grid.innerHTML = sorted.map((pk) => {
      const isLead = crowned.has(pk);
      const b = battle[pk];
      const record = season.players.length > 2
        ? `${b.wins} – ${b.losses}${b.ties ? ` – ${b.ties}` : ""}`
        : (b.wins === 1 ? "Leading" : b.losses === 1 ? "Behind" : "Tied");

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
          <div class="record">${record}</div>
          <div class="h2h-list">${bars}</div>
          <div class="total-small">${formatPts(combined[pk] || 0)} pts total</div>
        </div>
      `;
    }).join("");
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

  // Master re-render for the statistics view — chart + all panels
  function redrawStatistics() {
    const filters = readStatsFilters();
    drawLifetimeChart(filters);
    drawH2HPanel(filters);
    drawCoursesPanel(filters);
    drawPatternsPanel(filters);
    drawMilestonesPanel(filters);
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

    // Stats panel
    drawLifetimeStats(points);
  }

  function chooseTimeUnit(from, to) {
    if (!from || !to) return "year";
    const d1 = new Date(from); const d2 = new Date(to);
    const days = (d2 - d1) / (1000 * 60 * 60 * 24);
    if (days < 90) return "week";
    if (days < 365 * 1.5) return "month";
    return "year";
  }

  function drawLifetimeStats(points) {
    const wrap = document.getElementById("lifetime-stats");
    const cards = [];
    for (const pk of PLAYER_ORDER) {
      const pts = points[pk] || [];
      if (!pts.length) continue;
      const ys = pts.map((p) => p.y);
      const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
      const best = Math.min(...ys);
      cards.push(`
        <div class="stat" style="border-left: 4px solid ${PLAYER_COLORS[pk]}">
          <div class="stat-label">${PLAYER_NAMES[pk]} · avg / best</div>
          <div class="stat-value">${avg.toFixed(1)} <span style="font-size:14px;color:var(--ink-muted)">/ ${best}</span></div>
          <div class="muted small">${pts.length} rounds</div>
        </div>
      `);
    }
    wrap.innerHTML = cards.join("");
  }

  // ============================================================
  // STATISTICS PANELS
  // ============================================================

  // Panel: Head-to-head records (per visible pair)
  function drawH2HPanel(filters) {
    const wrap = document.querySelector("#stats-h2h .stats-content");
    if (!wrap) return;
    const players = PLAYER_ORDER.filter((k) => filters.visible[k] !== false);
    if (players.length < 2) {
      wrap.innerHTML = `<p class="muted small">Enable at least 2 players.</p>`;
      return;
    }

    // Collect events into per-pair round outcomes
    const pairs = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        pairs.push([players[i], players[j]]);
      }
    }
    const stats = pairs.map(([a, b]) => computeH2H(a, b, filters));
    wrap.innerHTML = stats.map((s) => renderH2HCard(s)).join("");
    if (!stats.length) wrap.innerHTML = `<p class="muted small">No matchups found.</p>`;
  }

  function computeH2H(a, b, filters) {
    const rounds = [];
    forEachFilteredEvent(filters, (ev) => {
      const pa = ev.players[a]; const pb = ev.players[b];
      if (!pa || !pb) return;
      // Only rounds where both actually played (have a score OR imported points against each other)
      const aPts = (pa.pointsImported || {})["vs" + capitalize(b)] || 0;
      const bPts = (pb.pointsImported || {})["vs" + capitalize(a)] || 0;
      const bothPlayed = (pa.front9 != null || pa.back9 != null) && (pb.front9 != null || pb.back9 != null);
      if (!bothPlayed && !aPts && !bPts) return;
      const diff = aPts - bPts;
      rounds.push({
        date: ev.date, course: ev.course,
        aPts, bPts, diff,
        aFull18: full18For(pa), bFull18: full18For(pb),
        aFront: pa.front9, bFront: pb.front9,
        aBack: pa.back9, bBack: pb.back9,
      });
    });
    rounds.sort((r1, r2) => r1.date.localeCompare(r2.date));

    let aWins = 0, bWins = 0, ties = 0;
    let curStreakPlayer = null, curStreak = 0;
    let bestStreak = { player: null, len: 0 };
    let comebacks = 0;
    for (const r of rounds) {
      let winner = null;
      if (r.diff > 0) { aWins++; winner = a; }
      else if (r.diff < 0) { bWins++; winner = b; }
      else ties++;

      if (winner) {
        if (curStreakPlayer === winner) curStreak++;
        else { curStreakPlayer = winner; curStreak = 1; }
        if (curStreak > bestStreak.len) bestStreak = { player: winner, len: curStreak };
      } else {
        curStreakPlayer = null; curStreak = 0;
      }

      // Comeback: lost front 9 by any margin, won 18 total by any margin
      if (r.aFront != null && r.bFront != null && r.aFull18 != null && r.bFull18 != null) {
        if (r.aFront > r.bFront && r.aFull18 < r.bFull18) comebacks++;   // A comeback
        if (r.bFront > r.aFront && r.bFull18 < r.aFull18) comebacks++;   // B comeback
      }
    }

    // Biggest single-round margin
    let biggest = null;
    for (const r of rounds) {
      const mag = Math.abs(r.diff);
      if (mag > 0 && (!biggest || mag > Math.abs(biggest.diff))) biggest = r;
    }

    return {
      a, b, rounds, aWins, bWins, ties,
      curStreakPlayer, curStreak, bestStreak, comebacks, biggest,
    };
  }

  function renderH2HCard(s) {
    if (!s.rounds.length) {
      return `<div class="h2h-card"><h4>${PLAYER_NAMES[s.a]} vs ${PLAYER_NAMES[s.b]}</h4><p class="muted small">No rounds in this range.</p></div>`;
    }
    const streakTxt = s.curStreak > 1
      ? `<span class="pl-${s.curStreakPlayer}">${PLAYER_NAMES[s.curStreakPlayer]}</span> won last ${s.curStreak}`
      : (s.curStreak === 1 ? `<span class="pl-${s.curStreakPlayer}">${PLAYER_NAMES[s.curStreakPlayer]}</span> won last round` : "—");
    const bestStreakTxt = s.bestStreak.len > 1
      ? `<span class="pl-${s.bestStreak.player}">${PLAYER_NAMES[s.bestStreak.player]}</span> ${s.bestStreak.len} in a row`
      : "—";
    const biggestTxt = s.biggest
      ? (() => {
          const winner = s.biggest.diff > 0 ? s.a : s.b;
          const mag = Math.abs(s.biggest.diff);
          return `<span class="pl-${winner}">${PLAYER_NAMES[winner]}</span> +${mag} <span class="muted">— ${formatShortDate(s.biggest.date)} · ${escapeHtml(s.biggest.course || "")}</span>`;
        })()
      : "—";
    return `
      <div class="h2h-card">
        <h4>${PLAYER_NAMES[s.a]} vs ${PLAYER_NAMES[s.b]} <span class="muted small">— ${s.rounds.length} rounds</span></h4>
        <div class="h2h-record">
          <span class="pl-${s.a}">${s.aWins}</span>
          <span class="dash">·</span>
          <span class="muted">${s.ties} tied</span>
          <span class="dash">·</span>
          <span class="pl-${s.b}">${s.bWins}</span>
        </div>
        <dl class="h2h-details">
          <dt>Current streak</dt><dd>${streakTxt}</dd>
          <dt>Longest streak</dt><dd>${bestStreakTxt}</dd>
          <dt>Biggest single-round win</dt><dd>${biggestTxt}</dd>
          <dt>Comebacks (lost F9, won 18)</dt><dd>${s.comebacks}</dd>
        </dl>
      </div>
    `;
  }

  // Panel: Course insights
  function drawCoursesPanel(filters) {
    const wrap = document.querySelector("#stats-courses .stats-content");
    if (!wrap) return;
    const players = PLAYER_ORDER.filter((k) => filters.visible[k] !== false);
    if (!players.length) { wrap.innerHTML = ""; return; }

    // Per-course, per-player: list of 18-hole scores
    const perCourse = {};
    forEachFilteredEvent(filters, (ev) => {
      const c = (ev.course || "").trim();
      if (!c) return;
      perCourse[c] = perCourse[c] || {};
      for (const pk of players) {
        const p = ev.players[pk];
        const t = full18For(p);
        if (t == null) continue;
        perCourse[c][pk] = perCourse[c][pk] || [];
        perCourse[c][pk].push(t);
      }
    });

    // Keep courses with ≥ 3 total rounds (across visible players)
    const rows = Object.entries(perCourse)
      .map(([course, byPlayer]) => {
        const totalRounds = Object.values(byPlayer).reduce((s, arr) => s + arr.length, 0);
        const perP = {};
        for (const pk of players) {
          const arr = byPlayer[pk] || [];
          perP[pk] = arr.length
            ? { avg: arr.reduce((a, b) => a + b, 0) / arr.length, best: Math.min(...arr), n: arr.length }
            : null;
        }
        // Dominant player: lowest avg AND ≥ 2 rounds
        const eligible = Object.entries(perP).filter(([_, s]) => s && s.n >= 2);
        let dominant = null;
        if (eligible.length >= 2) {
          eligible.sort((x, y) => x[1].avg - y[1].avg);
          dominant = eligible[0][0];
        }
        return { course, totalRounds, perP, dominant };
      })
      .filter((r) => r.totalRounds >= 3)
      .sort((a, b) => b.totalRounds - a.totalRounds);

    if (!rows.length) {
      wrap.innerHTML = `<p class="muted small">No courses with 3+ rounds in this range.</p>`;
      return;
    }

    const header = `<tr><th class="col-course">Course</th><th class="col-rounds">n</th>${players.map((pk) => `<th class="col-p pl-${pk}">${PLAYER_NAMES[pk]}</th>`).join("")}<th class="col-dom">Best</th></tr>`;
    const body = rows.slice(0, 20).map((r) => {
      const cells = players.map((pk) => {
        const s = r.perP[pk];
        if (!s) return `<td class="col-p">—</td>`;
        return `<td class="col-p"><span class="avg">${s.avg.toFixed(1)}</span> <span class="best muted">/ ${s.best}</span> <span class="n muted small">(${s.n})</span></td>`;
      }).join("");
      const domCell = r.dominant ? `<td class="col-dom pl-${r.dominant}">${PLAYER_NAMES[r.dominant]}</td>` : `<td class="col-dom muted">—</td>`;
      return `<tr><td class="col-course">${escapeHtml(r.course)}</td><td class="col-rounds">${r.totalRounds}</td>${cells}${domCell}</tr>`;
    }).join("");
    wrap.innerHTML = `<table class="courses-table"><thead>${header}</thead><tbody>${body}</tbody></table>
      ${rows.length > 20 ? `<p class="muted small">Showing top 20 of ${rows.length} courses. Narrow the range or filter by course to see others.</p>` : ""}`;
  }

  // Panel: Score patterns
  function drawPatternsPanel(filters) {
    const wrap = document.querySelector("#stats-patterns .stats-content");
    if (!wrap) return;
    const players = PLAYER_ORDER.filter((k) => filters.visible[k] !== false);

    // Collect per-player scores + front + back + month
    const data = {};
    for (const pk of players) data[pk] = { total: [], front: [], back: [], byMonth: {} };
    forEachFilteredEvent(filters, (ev) => {
      const month = Number(ev.date.slice(5, 7));
      for (const pk of players) {
        const p = ev.players[pk];
        if (!p) continue;
        if (p.front9 != null) data[pk].front.push(p.front9);
        if (p.back9 != null) data[pk].back.push(p.back9);
        const t = full18For(p);
        if (t != null) {
          data[pk].total.push(t);
          data[pk].byMonth[month] = data[pk].byMonth[month] || [];
          data[pk].byMonth[month].push(t);
        }
      }
    });

    const hasAny = players.some((pk) => data[pk].total.length > 0);
    if (!hasAny) { wrap.innerHTML = `<p class="muted small">No data in this range.</p>`; return; }

    // Distribution bins
    const bins = [
      { label: "< 80", min: 0, max: 79 },
      { label: "80-84", min: 80, max: 84 },
      { label: "85-89", min: 85, max: 89 },
      { label: "90-94", min: 90, max: 94 },
      { label: "95-99", min: 95, max: 99 },
      { label: "100+", min: 100, max: 9999 },
    ];
    const distMax = Math.max(1, ...players.flatMap((pk) => bins.map((b) => data[pk].total.filter((s) => s >= b.min && s <= b.max).length)));

    // Months present
    const monthsPresent = Array.from(new Set(players.flatMap((pk) => Object.keys(data[pk].byMonth).map(Number)))).sort((a, b) => a - b);
    const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    let html = `<div class="pattern-blocks">`;

    // 1. Distribution
    html += `<div class="pattern-block"><h5>18-hole score distribution</h5><div class="dist-grid">`;
    for (const pk of players) {
      const totals = data[pk].total;
      if (!totals.length) continue;
      html += `<div class="dist-row"><div class="dist-label pl-${pk}">${PLAYER_NAMES[pk]}</div>`;
      for (const b of bins) {
        const n = totals.filter((s) => s >= b.min && s <= b.max).length;
        const h = distMax ? Math.max(2, (n / distMax) * 40) : 2;
        html += `<div class="dist-bin"><div class="dist-bar bar-${pk}" style="height:${h}px" title="${b.label}: ${n} rounds"></div><div class="dist-count">${n}</div><div class="dist-blabel muted">${b.label}</div></div>`;
      }
      html += `</div>`;
    }
    html += `</div></div>`;

    // 2. Front vs Back
    html += `<div class="pattern-block"><h5>Front 9 vs Back 9 (avg)</h5><table class="fb-table"><thead><tr><th></th><th>Front 9</th><th>Back 9</th><th>Diff</th></tr></thead><tbody>`;
    for (const pk of players) {
      const f = data[pk].front; const b = data[pk].back;
      if (!f.length && !b.length) continue;
      const favg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
      const bavg = b.length ? b.reduce((a, b) => a + b, 0) / b.length : null;
      const diff = (favg != null && bavg != null) ? (favg - bavg).toFixed(1) : "—";
      html += `<tr><td class="pl-${pk}">${PLAYER_NAMES[pk]}</td><td>${favg != null ? favg.toFixed(1) : "—"}<span class="muted small"> (${f.length})</span></td><td>${bavg != null ? bavg.toFixed(1) : "—"}<span class="muted small"> (${b.length})</span></td><td>${diff}</td></tr>`;
    }
    html += `</tbody></table></div>`;

    // 3. Monthly averages
    if (monthsPresent.length > 1) {
      html += `<div class="pattern-block"><h5>Average by month</h5><table class="fb-table"><thead><tr><th></th>${monthsPresent.map((m) => `<th>${MONTH_NAMES[m]}</th>`).join("")}</tr></thead><tbody>`;
      for (const pk of players) {
        if (!data[pk].total.length) continue;
        html += `<tr><td class="pl-${pk}">${PLAYER_NAMES[pk]}</td>`;
        for (const m of monthsPresent) {
          const arr = data[pk].byMonth[m] || [];
          if (!arr.length) html += `<td class="muted">—</td>`;
          else html += `<td>${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)}<span class="muted small"> (${arr.length})</span></td>`;
        }
        html += `</tr>`;
      }
      html += `</tbody></table></div>`;
    }

    // 4. Consistency (stddev)
    html += `<div class="pattern-block"><h5>Consistency (18-hole score standard deviation — lower = steadier)</h5><table class="fb-table"><thead><tr><th></th><th>Rounds</th><th>Avg</th><th>Best</th><th>StdDev</th></tr></thead><tbody>`;
    for (const pk of players) {
      const arr = data[pk].total;
      if (!arr.length) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const std = Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
      html += `<tr><td class="pl-${pk}">${PLAYER_NAMES[pk]}</td><td>${arr.length}</td><td>${avg.toFixed(1)}</td><td>${Math.min(...arr)}</td><td>${std.toFixed(1)}</td></tr>`;
    }
    html += `</tbody></table></div>`;

    html += `</div>`;
    wrap.innerHTML = html;
  }

  // Panel: Milestones
  function drawMilestonesPanel(filters) {
    const wrap = document.querySelector("#stats-milestones .stats-content");
    if (!wrap) return;
    const players = PLAYER_ORDER.filter((k) => filters.visible[k] !== false);

    const stats = {};
    for (const pk of players) {
      stats[pk] = {
        rounds: 0,
        points: 0,
        ties: 0,
        sweeps: 0,
        eagles: 0,
        best18: null,   // { score, date, course }
        best9: null,    // { score, date, course, which }
      };
    }

    forEachFilteredEvent(filters, (ev) => {
      // For sweep detection we need points against every other visible player
      for (const pk of players) {
        const p = ev.players[pk];
        if (!p) continue;
        const scored = (p.front9 != null || p.back9 != null);
        if (!scored) continue;
        const s = stats[pk];
        s.rounds++;
        if (p.eagle) s.eagles++;
        const t = full18For(p);
        if (t != null && (s.best18 == null || t < s.best18.score)) {
          s.best18 = { score: t, date: ev.date, course: ev.course };
        }
        if (p.front9 != null && (s.best9 == null || p.front9 < s.best9.score)) {
          s.best9 = { score: p.front9, date: ev.date, course: ev.course, which: "F9" };
        }
        if (p.back9 != null && (s.best9 == null || p.back9 < s.best9.score)) {
          s.best9 = { score: p.back9, date: ev.date, course: ev.course, which: "B9" };
        }
        // Sum points scored
        const pi = p.pointsImported || {};
        for (const v of Object.values(pi)) s.points += (v || 0);
        // Ties in a matchup
        for (const opp of players) {
          if (opp === pk) continue;
          const opper = ev.players[opp];
          if (!opper) continue;
          const my = (pi["vs" + capitalize(opp)]) || 0;
          const theirs = ((opper.pointsImported || {})["vs" + capitalize(pk)]) || 0;
          if (my === theirs && my === 0) {
            // Only count as a "tie" if both actually played this event
            const bothPlayed = (p.front9 != null || p.back9 != null) && (opper.front9 != null || opper.back9 != null);
            if (bothPlayed) s.ties += 0.5;   // will count each pair once via +0.5 * 2
          }
        }
        // Sweep: winning against every visible opponent in this event
        if (players.length >= 3) {
          const opps = players.filter((k) => k !== pk);
          const allBeat = opps.every((opp) => {
            const opper = ev.players[opp];
            if (!opper) return false;
            const my = (pi["vs" + capitalize(opp)]) || 0;
            const theirs = ((opper.pointsImported || {})["vs" + capitalize(pk)]) || 0;
            return my > theirs;
          });
          if (allBeat && opps.length >= 2) s.sweeps++;
        }
      }
    });

    // Ties were counted as +0.5 per pair-per-event but each pair emits it twice — normalize
    // (Not quite right — actually I counted 0.5 for each player's perspective. Total ties per event = sum of 0.5 for both sides = 1. So dividing by 2 per player... let me just make ties be integer count of tied matchups.)
    // Reset ties with a cleaner calc:
    for (const pk of players) stats[pk].ties = 0;
    forEachFilteredEvent(filters, (ev) => {
      for (const pk of players) {
        const p = ev.players[pk];
        if (!p || (p.front9 == null && p.back9 == null)) continue;
        for (const opp of players) {
          if (opp === pk) continue;
          const opper = ev.players[opp];
          if (!opper || (opper.front9 == null && opper.back9 == null)) continue;
          const my = ((p.pointsImported || {})["vs" + capitalize(opp)]) || 0;
          const theirs = ((opper.pointsImported || {})["vs" + capitalize(pk)]) || 0;
          if (my === theirs) stats[pk].ties++;
        }
      }
    });

    const anyRounds = players.some((pk) => stats[pk].rounds > 0);
    if (!anyRounds) { wrap.innerHTML = `<p class="muted small">No data in this range.</p>`; return; }

    wrap.innerHTML = `<div class="milestone-grid">${players.map((pk) => {
      const s = stats[pk];
      if (!s.rounds) return "";
      return `
        <div class="milestone-card player-card ${pk}">
          <div class="name"><span class="dot"></span>${PLAYER_NAMES[pk]}</div>
          <dl class="milestones">
            <dt>Best 18</dt><dd>${s.best18 ? `<b>${s.best18.score}</b> <span class="muted small">${formatShortDate(s.best18.date)} · ${escapeHtml(s.best18.course || "")}</span>` : "—"}</dd>
            <dt>Best 9</dt><dd>${s.best9 ? `<b>${s.best9.score}</b> <span class="muted small">${s.best9.which} · ${formatShortDate(s.best9.date)} · ${escapeHtml(s.best9.course || "")}</span>` : "—"}</dd>
            <dt>Rounds</dt><dd>${s.rounds}</dd>
            <dt>Points scored</dt><dd>${formatPts(s.points)}</dd>
            <dt>Ties (matchup)</dt><dd>${s.ties}</dd>
            ${players.length >= 3 ? `<dt>Sweep rounds</dt><dd>${s.sweeps}</dd>` : ""}
            <dt>Eagles</dt><dd>${s.eagles}</dd>
          </dl>
        </div>
      `;
    }).join("")}</div>`;
  }

  // OLS over date-as-numeric
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
    const rows = summaries.map((s) => {
      const winnerKey = s.winnerKey || "tie";
      return `
        <tr>
          <td>${s.year}</td>
          <td><span class="winner-${winnerKey}">${s.winnerLabel}</span></td>
          <td>${s.eric != null ? formatPts(s.eric) : "—"}</td>
          <td>${s.pete != null ? formatPts(s.pete) : "—"}</td>
          <td>${s.jim != null ? s.jim : "—"}</td>
          <td>${s.notes || ""}</td>
        </tr>
      `;
    }).join("");
    document.getElementById("all-years-table").innerHTML = `
      <table class="all-years-table">
        <thead>
          <tr>
            <th>Year</th>
            <th>Season Winner</th>
            <th>Eric (vs P)</th>
            <th>Pete (vs E)</th>
            <th>Jim (vs E / vs P)</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    const titleStats = aggregateTitles(summaries);
    document.getElementById("title-card").innerHTML = `
      <div class="title-stat"><span class="label">Eric titles</span><span class="value" style="color:${PLAYER_COLORS.eric}">${titleStats.eric}</span></div>
      <div class="title-stat"><span class="label">Pete titles</span><span class="value" style="color:${PLAYER_COLORS.pete}">${titleStats.pete}</span></div>
      <div class="title-stat"><span class="label">Jim titles</span><span class="value" style="color:${PLAYER_COLORS.jim}">${titleStats.jim}</span></div>
      <div class="title-stat"><span class="label">Ties</span><span class="value">${titleStats.tie}</span></div>
    `;
  }

  function computeAllYearsSummaries() {
    const out = [];
    const years = Object.keys(state.data.seasons || {}).map(Number).sort((a, b) => a - b);
    for (const y of years) {
      const season = state.data.seasons[String(y)];
      const result = Scoring.determineSeasonResult(season, true);
      const totals = result.totals;

      const ericPts = totals.eric ? totals.eric.vsPete : null;
      const petePts = totals.pete ? totals.pete.vsEric : null;
      let jimText = null;
      if (totals.jim) {
        jimText = `${formatPts(totals.jim.vsEric || 0)} / ${formatPts(totals.jim.vsPete || 0)}`;
      }

      // Season winner — past only. Use new title-holders rule (E-vs-P decides 3-player years
      // unless Jim's combined exceeds both).
      const combined = result.combined;
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
        eric: ericPts,
        pete: petePts,
        jim: jimText,
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
        location.hash = `#/season/${year}`;
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
            location.hash = `#/season/${year}`;
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
      location.hash = `#/season/${year}`;
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
        location.hash = `#/season/${year}`;
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
      location.hash = `#/season/${year}`;
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
        location.hash = `#/season/${year}`;
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
