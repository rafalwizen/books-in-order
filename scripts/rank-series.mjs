// Rank candidate book series by Wikipedia popularity and pick the top set
// for import into src/content/series/.
//
// Usage: node scripts/rank-series.mjs [--months 12] [--top 100] [--reserve 20] [--refresh]
//
// Metric: median of the monthly view counts over the window (robust against
// short adaptation-driven spikes). Ranking is deterministic:
// median desc -> totalViews desc -> slug asc.
//
// Outputs (committed as an audit trail):
//   scripts/data/ranking.json   - full ranking for every candidate
//   scripts/data/selection.json - top N non-existing candidates + reserve

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './lib/http.mjs';
import { getPageviews, resolveRedirect } from './lib/wiki.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SCRIPTS_DIR, 'data');
const SERIES_DIR = path.join(SCRIPTS_DIR, '..', 'src', 'content', 'series');

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { months: 12, top: 100, reserve: 20, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--months') args.months = Number(argv[++i]);
    else if (argv[i] === '--top') args.top = Number(argv[++i]);
    else if (argv[i] === '--reserve') args.reserve = Number(argv[++i]);
    else if (argv[i] === '--refresh') args.refresh = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

// Window of the last N full months, e.g. run in 2026-10 -> 2025-10 .. 2026-09.
function computeWindow(monthsBack) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { from: ym(start), to: ym(end) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ---------- Candidate resolution ----------

function attemptsFor(candidate) {
  const attempts = [];
  const push = (project, article) => {
    if (project && article) attempts.push({ project, article });
  };
  push(candidate.wiki?.project ?? 'en', candidate.wiki?.article);
  for (const fb of candidate.wiki?.fallbacks ?? []) {
    push(fb.project ?? 'en', fb.article);
  }
  return attempts;
}

async function resolveCandidate(candidate, window, { refresh }) {
  const tried = [];
  for (const { project, article } of attemptsFor(candidate)) {
    // 1. direct fetch under the given title
    let items = await getPageviews(project, article, window.from, window.to, { refresh });
    if (items) return { project, article, items, tried };
    tried.push(`${project}:${article}`);

    // 2. the title may be a redirect — resolve and retry with the canonical title
    const canonical = await resolveRedirect(project, article, { refresh });
    if (canonical && canonical.replaceAll(' ', '_') !== article.replaceAll(' ', '_')) {
      items = await getPageviews(project, canonical, window.from, window.to, { refresh });
      if (items) return { project, article: canonical, items, tried };
      tried.push(`${project}:${canonical}`);
    }
  }
  return { project: null, article: null, items: null, tried };
}

// ---------- Main ----------

const args = parseArgs(process.argv.slice(2));
const window = computeWindow(args.months);
const candidates = JSON.parse(await readFile(path.join(DATA_DIR, 'candidates.json'), 'utf8'));
const existing = JSON.parse(await readFile(path.join(DATA_DIR, 'existing-series.json'), 'utf8'));
const existingSlugs = new Set(existing.series.map((s) => s.slug));
const existingTitles = new Set(
  existing.series.flatMap((s) => [s.title.toLowerCase(), ...s.aliases.map((a) => a.toLowerCase())]),
);

const filesInSeriesDir = new Set(
  (await readdir(SERIES_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
);

console.log(`Ranking ${candidates.length} candidates by Wikipedia pageviews ${window.from}..${window.to}`);
const pool = createPool(4, 100);
const results = await Promise.all(
  candidates.map((candidate) =>
    pool(async () => {
      const resolved = await resolveCandidate(candidate, window, { refresh: args.refresh });
      if (!resolved.items) {
        return {
          slug: candidate.slug,
          workingTitle: candidate.workingTitle,
          author: candidate.author,
          existingSlug: candidate.existingSlug ?? null,
          status: 'not-found',
          tried: resolved.tried,
          medianMonthlyViews: 0,
          totalViews: 0,
          monthly: {},
        };
      }
      const views = resolved.items.map((i) => i.views);
      // Fill months with no data as 0 so young articles rank honestly.
      const monthly = {};
      {
        const [fy, fm] = window.from.split('-').map(Number);
        const d = new Date(Date.UTC(fy, fm - 1, 1));
        for (let m = 0; m < args.months; m++) {
          const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
          monthly[key] = 0;
          d.setUTCMonth(d.getUTCMonth() + 1);
        }
        for (const item of resolved.items) monthly[item.timestamp] = item.views;
      }
      const allViews = Object.values(monthly);
      return {
        slug: candidate.slug,
        workingTitle: candidate.workingTitle,
        author: candidate.author,
        existingSlug: candidate.existingSlug ?? null,
        status: 'ok',
        resolved: { project: resolved.project, article: resolved.article },
        medianMonthlyViews: median(allViews),
        totalViews: allViews.reduce((a, b) => a + b, 0),
        monthly,
      };
    }),
  ),
);

// Deterministic order: median desc -> total desc -> slug asc.
const sorted = results.sort(
  (a, b) =>
    b.medianMonthlyViews - a.medianMonthlyViews ||
    b.totalViews - a.totalViews ||
    a.slug.localeCompare(b.slug),
);

const unresolved = sorted.filter((r) => r.status === 'not-found');
const ok = sorted.filter((r) => r.status === 'ok');

// Drop anything that duplicates a series we already ship, directly or by alias.
const skipped = [];
const selectable = ok.filter((r) => {
  const candidate = candidates.find((c) => c.slug === r.slug);
  if (candidate?.existingSlug || existingSlugs.has(r.slug) || filesInSeriesDir.has(r.slug)) {
    skipped.push({ slug: r.slug, reason: 'already exists on site' });
    return false;
  }
  if (existingTitles.has(r.workingTitle.toLowerCase())) {
    skipped.push({ slug: r.slug, reason: 'alias of an existing series' });
    return false;
  }
  return true;
});

const selected = selectable.slice(0, args.top).map((r, i) => ({
  rank: i + 1,
  slug: r.slug,
  workingTitle: r.workingTitle,
  author: r.author,
  medianMonthlyViews: r.medianMonthlyViews,
  source: `${r.resolved.project}.wikipedia/wiki/${r.resolved.article}`,
}));
const reserve = selectable.slice(args.top, args.top + args.reserve).map((r, i) => ({
  rank: args.top + i + 1,
  slug: r.slug,
  workingTitle: r.workingTitle,
  author: r.author,
  medianMonthlyViews: r.medianMonthlyViews,
  source: `${r.resolved.project}.wikipedia/wiki/${r.resolved.article}`,
}));

await writeFile(
  path.join(DATA_DIR, 'ranking.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), window, items: sorted }, null, 2),
  'utf8',
);
await writeFile(
  path.join(DATA_DIR, 'selection.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), window, selected, reserve, unresolved, skipped },
    null,
    2,
  ),
  'utf8',
);

// ---------- Console report ----------

console.log('\nTop 40 by median monthly views:');
for (const r of sorted.slice(0, 40)) {
  const flag = r.status === 'ok' ? '' : '  [NOT FOUND]';
  const skip = r.existingSlug ? ' (existing)' : '';
  console.log(
    `${String(r.medianMonthlyViews).padStart(7)}  ${r.workingTitle}${skip}${flag}`,
  );
}

if (unresolved.length > 0) {
  console.log(`\nUnresolved articles (${unresolved.length}) — fix candidates.json:`);
  for (const r of unresolved) console.log(`  ${r.slug} (tried: ${r.tried.join(', ')})`);
}

console.log(`\nSelected: ${selected.length}, reserve: ${reserve.length}, skipped: ${skipped.length}, unresolved: ${unresolved.length}`);
console.log('Borderline entries around the cut (for a possible hand-swap):');
for (const r of selectable.slice(Math.max(0, args.top - 5), args.top + 10)) {
  console.log(`  ${r.medianMonthlyViews}  ${r.slug}`);
}

if (unresolved.length === sorted.length) {
  console.error('No candidate resolved — aborting.');
  process.exit(1);
}
