// Matches a TMDB title/year/poster to an entry in the provider's VOD/series
// catalog. The provider has no text-search endpoint, so this always runs
// against a full (already-fetched) catalog array — see match.js for caching.
function normalizeTitle(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Only TMDB-hosted images carry a filename we can match 1:1 against our own
// TMDB poster_path — provider-hosted images have no relation to TMDB ids.
function posterFile(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)image\.tmdb\.org$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

function byYearCloseness(wantYear) {
  return (a, b) => Math.abs((Number(a.year) || 0) - wantYear) - Math.abs((Number(b.year) || 0) - wantYear);
}

// catalog: array of {id, title, year, poster, ext?}. Tiered: exact poster
// match (highest confidence) → exact normalized title (+ nearest year) →
// fuzzy substring title (+ year within 2). Returns the best candidate or null.
function findMatch(catalog, { title, year, poster }) {
  const wantPoster = posterFile(poster);
  const wantTitle = normalizeTitle(title);
  const wantYear = year ? Number(year) : null;

  if (wantPoster) {
    const exact = catalog.filter((c) => c.poster === wantPoster);
    if (exact.length) {
      if (exact.length > 1 && wantYear) exact.sort(byYearCloseness(wantYear));
      return exact[0];
    }
  }

  const titleMatches = catalog.filter((c) => normalizeTitle(c.title) === wantTitle);
  if (titleMatches.length) {
    if (!wantYear) return titleMatches[0];
    titleMatches.sort(byYearCloseness(wantYear));
    const best = titleMatches[0];
    if (!best.year || Math.abs(Number(best.year) - wantYear) <= 1) return best;
  }

  if (wantTitle.length >= 3) {
    const fuzzy = catalog.filter((c) => {
      const t = normalizeTitle(c.title);
      return t && (t.includes(wantTitle) || wantTitle.includes(t));
    });
    if (fuzzy.length) {
      if (!wantYear) return fuzzy[0];
      fuzzy.sort(byYearCloseness(wantYear));
      const best = fuzzy[0];
      if (!best.year || Math.abs(Number(best.year) - wantYear) <= 2) return best;
    }
  }
  return null;
}

module.exports = { normalizeTitle, posterFile, findMatch };
