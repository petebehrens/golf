// storage.js — Read/write seasons.json from this GitHub repo.
// Read: works for everyone (public repo).
// Write: requires a fine-grained PAT scoped to this repo, contents:write.
//        Stored only in localStorage on the user's device.

(function (root) {
  "use strict";

  const LS_PAT = "golf.pat";
  const LS_REPO = "golf.repo";          // { owner, repo, path, branch }
  const LS_DATA_CACHE = "golf.cache";   // {seasonsJson, sha, fetchedAt}
  const LS_PENDING = "golf.pendingTokenAck";

  // Defaults — overridable in Settings
  const DEFAULT_REPO = {
    owner: "petebehrens",
    repo: "golf",
    path: "data/seasons.json",
    branch: "main",
  };

  function getRepo() {
    try {
      const raw = localStorage.getItem(LS_REPO);
      if (!raw) return { ...DEFAULT_REPO };
      const r = JSON.parse(raw);
      return { ...DEFAULT_REPO, ...r };
    } catch (e) {
      return { ...DEFAULT_REPO };
    }
  }

  function setRepo(repo) {
    localStorage.setItem(LS_REPO, JSON.stringify(repo));
  }

  function getPat() {
    return localStorage.getItem(LS_PAT) || "";
  }

  function setPat(pat) {
    if (pat) localStorage.setItem(LS_PAT, pat);
    else localStorage.removeItem(LS_PAT);
  }

  function hasPat() {
    return !!getPat();
  }

  // --- READ via raw GitHub Pages (always works for our public repo) ---
  // First-party load: from same origin (./data/seasons.json). Falls back to GitHub contents API.
  async function fetchSeasons() {
    const repo = getRepo();
    // 1) Try same-origin (the deployed copy)
    try {
      const res = await fetch("./data/seasons.json", { cache: "no-cache" });
      if (res.ok) {
        const json = await res.json();
        return { data: json, sha: null, source: "static" };
      }
    } catch (e) { /* fall through */ }

    // 2) Try GitHub contents API (uses PAT if present, otherwise unauthenticated)
    try {
      const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.path}?ref=${repo.branch}`;
      const headers = { Accept: "application/vnd.github+json" };
      if (hasPat()) headers.Authorization = `Bearer ${getPat()}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
      const j = await res.json();
      const content = atob(j.content.replace(/\n/g, ""));
      return { data: JSON.parse(content), sha: j.sha, source: "api" };
    } catch (e) {
      console.warn("fetchSeasons fell through:", e);
      // 3) Last fallback: cached local copy
      const cached = localStorage.getItem(LS_DATA_CACHE);
      if (cached) {
        const obj = JSON.parse(cached);
        return { data: obj.seasonsJson, sha: obj.sha, source: "cache" };
      }
      throw e;
    }
  }

  function setCache(data, sha) {
    try {
      localStorage.setItem(LS_DATA_CACHE, JSON.stringify({
        seasonsJson: data, sha, fetchedAt: new Date().toISOString(),
      }));
    } catch (e) { /* quota: ignore */ }
  }

  /**
   * Save updated seasons JSON to the GitHub repo via API.
   * Uses optimistic concurrency: needs the latest sha; on 409 conflict we re-read and retry once.
   */
  async function saveSeasons(updated, prevSha, commitMessage) {
    if (!hasPat()) {
      throw new Error("No PAT configured. Open Settings to add one.");
    }
    const repo = getRepo();
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.path}`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getPat()}`,
      "Content-Type": "application/json",
    };

    async function attempt(sha) {
      const body = {
        message: commitMessage || "Update golf data",
        branch: repo.branch,
        content: utf8ToB64(JSON.stringify(updated, null, 2)),
      };
      if (sha) body.sha = sha;
      const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
      const json = await res.json();
      return { res, json };
    }

    let { res, json } = await attempt(prevSha);

    if (res.status === 409 || (res.status === 422 && /sha/i.test(JSON.stringify(json)))) {
      // Re-read, get new sha, retry once
      const { sha: latestSha } = await fetchViaApi();
      const r2 = await attempt(latestSha);
      res = r2.res; json = r2.json;
    }

    if (!res.ok) {
      throw new Error(json.message || `Save failed: ${res.status}`);
    }
    return { sha: json.content && json.content.sha, commit: json.commit };
  }

  async function fetchViaApi() {
    const repo = getRepo();
    const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.path}?ref=${repo.branch}`;
    const headers = { Accept: "application/vnd.github+json" };
    if (hasPat()) headers.Authorization = `Bearer ${getPat()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
    const j = await res.json();
    const content = atob(j.content.replace(/\n/g, ""));
    return { data: JSON.parse(content), sha: j.sha };
  }

  // -- helpers --
  function utf8ToB64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  // Encode/decode an event for share-link "suggest event" workflow
  function encodeSuggestion(event) {
    const json = JSON.stringify(event);
    return utf8ToB64(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeSuggestion(b64url) {
    let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return JSON.parse(b64ToUtf8(s));
  }

  const api = {
    LS_PAT, LS_REPO, LS_DATA_CACHE,
    DEFAULT_REPO,
    getRepo, setRepo,
    getPat, setPat, hasPat,
    fetchSeasons, fetchViaApi, saveSeasons, setCache,
    encodeSuggestion, decodeSuggestion,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GolfStorage = api;
  }
})(typeof window !== "undefined" ? window : this);
