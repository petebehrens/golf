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

    // Sort players by combined points desc (winner first)
    const sorted = season.players.slice().sort((a, b) => (combined[b] || 0) - (combined[a] || 0));

    // Past seasons: crown the title-holders (could be multiple in a tie).
    // Current/future: crown the sole leader if there's no tie at the top by combined points.
    const past = isPastSeason(season.year);
    let crowned = new Set();
    if (past) {
      (result.titleHolders || []).forEach((k) => crowned.add(k));
    } else {
      const leadVal = Math.max(...season.players.map((k) => combined[k] || 0));
      const leaders = season.players.filter((k) => (combined[k] || 0) === leadVal);
      if (leadVal > 0 && leaders.length === 1) crowned.add(leaders[0]);
    }

    grid.innerHTML = sorted.map((pk) => {
      const isLead = crowned.has(pk);
      // Build pair lines: "62 - 30 vs Pete" — for each opponent
      const pairLines = season.players
        .filter((opp) => opp !== pk)
        .map((opp) => {
          const myPts = ((totals[pk] || {})["vs" + capitalize(opp)]) || 0;
          const oppPts = ((totals[opp] || {})["vs" + capitalize(pk)]) || 0;
          return `<div class="pair-line">
            <span class="me">${formatPts(myPts)}</span>
            <span class="dash">–</span>
            <span class="opp">${formatPts(oppPts)} <span class="vs">vs ${PLAYER_NAMES[opp]}</span></span>
          </div>`;
        }).join("");
      // For 2-player heads-up, suppress redundant subtext (Pete asked: don't need "vs P")
      const showPairs = season.players.length > 2;
      return `
        <div class="player-card ${pk} ${isLead ? "lead" : ""}">
          <div class="name"><span class="dot"></span>${PLAYER_NAMES[pk]}</div>
          <div class="total">${formatPts(combined[pk] || 0)}</div>
          ${showPairs ? pairLines : ""}
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
    const rows = events.map((ev) => {
      const badges = badgesFor(ev);
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
            ${escapeHtml(ev.course)} ${badges}
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
    const rowsHtml = [];
    for (const ev of events) {
      const playersInEv = season.players.filter((pk) => {
        const p = ev.players[pk];
        return p && (played(p) || (Object.values(p.pointsImported || {}).some((v) => v)));
      });
      if (!playersInEv.length) continue;

      const badges = badgesFor(ev);
      const courseBlock = `${escapeHtml(ev.course)} ${badges}${ev.comments ? `<div class="comments">${escapeHtml(ev.comments)}</div>` : ""}`;

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

    const onChange = () => {
      customSpan.classList.toggle("hidden", rangeSelect.value !== "custom");
      drawLifetimeChart();
    };

    rangeSelect.addEventListener("change", onChange);
    document.getElementById("show-trend").addEventListener("change", drawLifetimeChart);
    document.getElementById("range-from").addEventListener("change", drawLifetimeChart);
    document.getElementById("range-to").addEventListener("change", drawLifetimeChart);
    document.querySelectorAll('.player-toggles input[data-player]').forEach((el) =>
      el.addEventListener("change", drawLifetimeChart));

    drawLifetimeChart();
  }

  function drawLifetimeChart() {
    const select = document.getElementById("range-picker");
    if (!select) return; // route changed
    const range = select.value;
    let from = null, to = null;

    const today = new Date();
    if (range && range.startsWith("year-")) {
      const y = range.slice(5);
      from = `${y}-01-01`; to = `${y}-12-31`;
    } else if (range === "custom") {
      from = document.getElementById("range-from").value || null;
      to = document.getElementById("range-to").value || null;
    }
    // "all": from/to remain null

    // Player visibility from toggles
    const visible = {};
    document.querySelectorAll('.player-toggles input[data-player]').forEach((el) => {
      visible[el.dataset.player] = el.checked;
    });

    // Collect every event from every season, with a per-player 18-equivalent score
    const points = { eric: [], pete: [], jim: [] };
    for (const yKey of Object.keys(state.data.seasons || {})) {
      const season = state.data.seasons[yKey];
      for (const ev of season.events) {
        if (from && ev.date < from) continue;
        if (to && ev.date > to) continue;
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
  function renderAddEvent(opts) {
    mountTemplate("tpl-add-event");
    const params = parseQuery((location.hash.split("?")[1]) || "");
    const year = params.year ? Number(params.year) : currentYear();
    const season = state.data.seasons[String(year)] || emptySeason(year);

    const form = document.getElementById("event-form");

    // Default date: today (if it's in this season's window) else season start
    form.elements.date.value = new Date().toISOString().slice(0, 10);

    // Render player rows
    renderPlayerRows(season);

    // Holes change → toggle 18 input visibility
    form.elements.holes.addEventListener("change", () => {
      togglePlayerInputs(form.elements.holes.value);
      updatePreview(season);
    });
    togglePlayerInputs(form.elements.holes.value);

    // Live preview
    form.addEventListener("input", () => updatePreview(season));

    // Actions
    document.getElementById("cancel-btn").addEventListener("click", () => {
      location.hash = `#/season/${year}`;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const event = formToEvent(form, season);

      // At least 2 players must have scored (you need a head-to-head matchup).
      // Players who didn't play are dropped from the event entirely.
      const playedKeys = season.players.filter((pk) => {
        const p = event.players[pk];
        return p && (p.front9 != null || p.back9 != null);
      });
      if (playedKeys.length < 2) {
        toast(`Need scores for at least 2 players`, true);
        return;
      }
      // Drop empty players so the event only records who actually played
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

      if (!Storage.hasPat()) {
        // Suggest mode: build URL and copy / share
        const suggestUrl = location.origin + location.pathname + `#/pending?event=${Storage.encodeSuggestion({ year, event })}`;
        await suggestEvent(suggestUrl, event);
        return;
      }

      // Save mode
      try {
        await saveEvent(year, event);
        toast("Round saved");
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
          <label><span class="lbl-front">Front 9</span> <input type="number" step="1" min="0" name="${pk}_front9" inputmode="numeric" /></label>
          <label data-only-18>Back 9 <input type="number" step="1" min="0" name="${pk}_back9" inputmode="numeric" /></label>
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

  function togglePlayerInputs(holes) {
    const wrap = document.getElementById("player-rows");
    wrap.querySelectorAll("[data-only-18]").forEach((el) => {
      el.style.display = holes === "18" ? "" : "none";
    });
    wrap.querySelectorAll(".lbl-front").forEach((el) => {
      el.textContent = holes === "9" ? "9 holes" : "Front 9";
    });
  }

  function formToEvent(form, season) {
    const fd = new FormData(form);
    const holes = Number(fd.get("holes"));
    const players = {};
    for (const pk of season.players) {
      const front9 = numOrNull(fd.get(`${pk}_front9`));
      let back9 = holes === 18 ? numOrNull(fd.get(`${pk}_back9`)) : null;
      // Single 9-hole round: input goes into "front9" but we store as front9.
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

  async function saveEvent(year, event) {
    const data = JSON.parse(JSON.stringify(state.data));
    if (!data.seasons[String(year)]) data.seasons[String(year)] = emptySeason(year);
    const season = data.seasons[String(year)];
    season.events.push(event);
    season.events.sort((a, b) => a.date.localeCompare(b.date));
    data.lastUpdated = new Date().toISOString();
    const result = await Storage.saveSeasons(data, state.sha, `Add round: ${event.date} ${event.course}`);
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
