// Verify series JSON files in src/content/series/:
//  A. local hard checks (schema shape, ordering, slug/genre conventions) -> failures exit 1
//  B. local warnings (intentional patterns like chronological ordering)    -> review only
//  C. Wikipedia cross-check (book titles/years vs the mapped article)     -> review only
//
// Usage: node scripts/verify-series.mjs [--slugs a,b,c] [--baseline] [--skip-wiki] [--refresh]
//   default: all files; --baseline: only the 10 pre-expansion series
//
// Outputs: scripts/data/verification/report-YYYY-MM-DD.md + latest.json

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugifyAuthor, slugifyTitle, transliterate } from './lib/slugify.mjs';
import { createPool } from './lib/http.mjs';
import { getWikitext } from './lib/wiki.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SCRIPTS_DIR, 'data');
const SERIES_DIR = path.join(SCRIPTS_DIR, '..', 'src', 'content', 'series');
const CURRENT_YEAR = new Date().getFullYear();

const TYPES = new Set(['powieść', 'opowiadanie', 'tom', 'powiązane']);

// ---------- CLI ----------

const argv = process.argv.slice(2);
const opts = { slugs: null, baseline: false, skipWiki: false, refresh: false, debugRows: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--slugs') opts.slugs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (argv[i] === '--baseline') opts.baseline = true;
  else if (argv[i] === '--skip-wiki') opts.skipWiki = true;
  else if (argv[i] === '--refresh') opts.refresh = true;
  else if (argv[i] === '--debug-rows') opts.debugRows = argv[++i];
  else throw new Error(`Unknown argument: ${argv[i]}`);
}

// ---------- Load inputs ----------

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const genreVocab = new Set((await readJsonOrNull(path.join(DATA_DIR, 'genre-vocabulary.json'))).genres);
const existingSeries = (await readJsonOrNull(path.join(DATA_DIR, 'existing-series.json'))).series;

async function loadWikiMappings() {
  const map = new Map(); // slug -> { attempts: [{project, article}] }
  const addAll = (entries) => {
    for (const e of entries ?? []) {
      if (e.slug && e.wiki?.article && !map.has(e.slug)) {
        map.set(e.slug, {
          attempts: [
            { project: e.wiki.project ?? 'en', article: e.wiki.article },
            ...(e.wiki.fallbacks ?? []).map((f) => ({ project: f.project ?? 'en', article: f.article })),
          ],
        });
      }
    }
  };
  addAll(existingSeries);
  addAll((await readJsonOrNull(path.join(DATA_DIR, 'candidates.json'))));
  const selection = await readJsonOrNull(path.join(DATA_DIR, 'selection.json'));
  // selection carries a resolved source URL, more accurate than the candidate guess
  for (const e of [...(selection?.selected ?? []), ...(selection?.reserve ?? [])]) {
    const m = /^([a-z]+)\.wikipedia\/wiki\/(.+)$/.exec(e.source ?? '');
    if (m) {
      map.set(e.slug, {
        attempts: [{ project: m[1], article: decodeURIComponent(m[2]).replaceAll('_', ' ') }],
      });
    }
  }
  return map;
}

const wikiMappings = opts.skipWiki ? new Map() : await loadWikiMappings();

// ---------- Local checks ----------

function checkSeriesLocal(slug, data) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);

  if (!/^[a-z0-9-]+$/.test(slug)) fail(`filename "${slug}" must match ^[a-z0-9-]+$`);

  for (const key of ['title', 'author', 'authorSlug', 'description']) {
    if (typeof data[key] !== 'string' || data[key].length === 0) fail(`missing string field "${key}"`);
  }
  if (!Array.isArray(data.genre) || data.genre.length < 1 || data.genre.length > 3) {
    fail('genre must be an array with 1-3 values');
  } else {
    for (const g of data.genre) if (!genreVocab.has(g)) fail(`genre "${g}" not in vocabulary`);
  }
  if (typeof data.description === 'string' && (data.description.length < 80 || data.description.length > 320)) {
    fail(`description length ${data.description.length} outside 80-320`);
  }
  if (!Array.isArray(data.faq) || data.faq.length < 2) fail('faq must have at least 2 items');
  if (data.faq) {
    for (const f of data.faq) {
      if (!f.question || !f.answer) fail('faq entries need question and answer');
    }
  }

  if (!Array.isArray(data.books) || data.books.length === 0) {
    fail('books must be a non-empty array');
    return { errors, warnings };
  }

  data.books.forEach((b, i) => {
    const label = `books[${i}] "${b.title ?? '?'}"`;
    if (b.order !== i + 1) fail(`${label}: order is ${b.order}, expected ${i + 1}`);
    if (typeof b.title !== 'string' || b.title.length === 0) fail(`${label}: missing title`);
    if (!Number.isInteger(b.yearOriginal) || b.yearOriginal < 1400 || b.yearOriginal > CURRENT_YEAR + 1) {
      fail(`${label}: yearOriginal ${b.yearOriginal} outside 1400-${CURRENT_YEAR + 1}`);
    }
    if (b.yearPolish != null) {
      if (!Number.isInteger(b.yearPolish) || b.yearPolish < b.yearOriginal || b.yearPolish > CURRENT_YEAR) {
        fail(`${label}: yearPolish ${b.yearPolish} must be within [yearOriginal, ${CURRENT_YEAR}]`);
      }
    }
    if (!TYPES.has(b.type ?? 'powieść')) fail(`${label}: unknown type "${b.type}"`);
  });

  if (slugifyAuthor(data.author ?? '') !== data.authorSlug) {
    fail(`authorSlug "${data.authorSlug}" !== slugifyAuthor("${data.author}") === "${slugifyAuthor(data.author ?? '')}"`);
  }

  const seenTitles = new Map();
  for (const b of data.books) {
    const key = normalizeTitle(b.title ?? '').join(' ');
    if (key && seenTitles.has(key)) fail(`duplicate book title "${b.title}" (orders ${seenTitles.get(key)} and ${b.order})`);
    seenTitles.set(key, b.order);
  }

  if (data.books.length < 2 || data.books.length > 45) warn(`unusual book count: ${data.books.length}`);
  if (data.books.filter((b) => b.type === 'powiązane').length > 5) warn('more than 5 powiązane entries');
  for (let i = 1; i < data.books.length; i++) {
    if (data.books[i].yearOriginal < data.books[i - 1].yearOriginal) {
      warn(`yearOriginal decreases at order ${data.books[i].order} (${data.books[i - 1].yearOriginal} -> ${data.books[i].yearOriginal}) — confirm intentional (chronology vs publication order)`);
      break; // one warning per series is enough to flag it
    }
  }
  if (slug && slugifyTitle(data.title ?? '') !== slug) {
    warn(`filename "${slug}" differs from slugify(title) "${slugifyTitle(data.title ?? '')}" (allowed when slug follows the popular Polish name)`);
  }

  return { errors, warnings };
}

// ---------- Title normalization & fuzzy matching ----------

const STOP_TOKENS = new Set(['the', 'a', 'an', 'of']);

function normalizeTitle(title) {
  return transliterate(String(title).toLowerCase())
    .replace(/\(.*?\)/g, ' ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_TOKENS.has(w));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function titleVariants(title) {
  const raw = String(title);
  const variants = [normalizeTitle(raw)];
  // Subtitle/alternative part after a comma or colon often differs between
  // our data and Wikipedia ("The Hobbit, or There and Back Again",
  // "Diary of a Wimpy Kid: Rodrick Rules").
  const comma = raw.indexOf(',');
  if (comma > 2) variants.push(normalizeTitle(raw.slice(0, comma)));
  const colon = raw.indexOf(': ');
  if (colon > 2) {
    variants.push(normalizeTitle(raw.slice(0, colon)));
    variants.push(normalizeTitle(raw.slice(colon + 2)));
  }
  return variants.filter((v) => v.length > 0);
}

const MATCH_THRESHOLD = 0.75;

// Pairwise similarity in [0, 1]: Jaccard, or 0.8 for a contained title
// (subset with at most 2 extra tokens on the bigger side).
function titleScore(aVariants, bVariants) {
  let best = 0;
  for (const a of aVariants) {
    for (const b of bVariants) {
      best = Math.max(best, jaccard(a, b));
      const [sa, sb] = [new Set(a), new Set(b)];
      const smaller = sa.size <= sb.size ? sa : sb;
      const bigger = sa.size <= sb.size ? sb : sa;
      const contained = smaller.size > 0 && [...smaller].every((t) => bigger.has(t));
      const close = smaller.size >= 2 && bigger.size <= smaller.size + 2;
      const distinctive = smaller.size === 1 && [...smaller][0].length >= 6 && bigger.size <= 4;
      if (contained && (close || distinctive)) best = Math.max(best, 0.8);
    }
  }
  return best;
}

// ---------- Wikipedia cross-check ----------

// Sections likely to hold the book publication table; anything else
// (adaptations, characters, reception) is skipped when these yield rows.
// Covers English and Polish heading conventions.
const WANTED_SECTION = /(publication|books?|novels?|series|bibliograph|chronolog|in order|stories|collected|omnibus|works|writing|wydani|powieśc|książk|tom(y|ów|u)?|cykl|publikac)/i;
const UNWANTED_SECTION = /(television|\btv\b|film|movie|game|adaptat|character|cast|reception|award|media|comic|graphic|audio|lego|merchan|inne media)/i;

function parseChunk(chunkLines) {
  // A logical table row (lines between |- separators) or a single list item.
  // Strip <ref> tags first: ref names like "Morgan1984" would fake years.
  const text = chunkLines
    .join(' ')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  // Year is optional: Polish book lists often enumerate titles without years.
  const years = [...text.matchAll(/\b(1[89]\d{2}|20[0-2]\d)\b/g)].map((m) => Number(m[1]));
  const candidates = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) candidates.push(m[1]);
  // Non-greedy italic span: titles may contain apostrophes ("Carl's Doomsday Scenario")
  for (const m of text.matchAll(/''(.+?)''/g)) candidates.push(m[1]);
  const title = candidates
    .map((t) => t.trim())
    // skip interwiki/namespace prefixes (File:, wikt:, en:...), keep titles
    // that merely contain a colon ("Chapterhouse: Dune")
    .filter((t) => !/^[a-z]{1,10}:/i.test(t) || /^wikt:/i.test(t))
    .filter((t) => /[a-zA-Z]/.test(t) && !/^\d+$/.test(t))
    .find((t) => t.split(/\s+/).length <= 12);
  if (!title) return null;
  return { title, year: years.length > 0 ? years[0] : null };
}

// Prefer a row with a year over one without; between two years prefer the
// earlier one (publication tables carry the original year).
function betterRow(a, b) {
  if (!a) return b;
  if (a.year == null && b.year != null) return b;
  if (a.year != null && b.year == null) return a;
  return (b.year ?? 9999) < (a.year ?? 9999) ? b : a;
}

function extractPublicationRows(wikitext) {
  const rowsAll = new Map();
  const rowsWanted = new Map();
  let wanted = false;
  // Collect logical rows: table rows (lines between |- / |} separators,
  // including leading "!" header cells) and standalone list items (#, *).
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    const row = parseChunk(block);
    block = [];
    if (!row) return;
    const key = normalizeTitle(row.title).join(' ');
    if (!key) return;
    for (const map of wanted ? [rowsAll, rowsWanted] : [rowsAll]) {
      map.set(key, betterRow(map.get(key), row));
    }
  };
  for (const rawLine of wikitext.split('\n')) {
    const line = rawLine.trim();
    const heading = /^(={2,6})\s*(.+?)\s*\1$/.exec(line);
    if (heading) {
      flush();
      wanted = WANTED_SECTION.test(heading[2]) && !UNWANTED_SECTION.test(heading[2]);
      continue;
    }
    if (/^\|-|^\|\}/.test(line)) {
      flush(); // new table row / table end
      continue;
    }
    if (/^[#*]/.test(line)) {
      // each list item is its own logical row
      flush();
      block.push(line);
    } else if (/^[!|]/.test(line)) {
      // table cells accumulate (title cell + year cell on following lines)
      block.push(line);
    } else {
      flush();
    }
  }
  flush();
  // Merge both pools; rows from publication sections override whole-article
  // duplicates (their years come from the actual publication table).
  const merged = new Map([...rowsAll, ...rowsWanted]);
  const sectionKeys = new Set(rowsWanted.keys());
  return { rows: [...merged.values()], sectionKeys };
}

async function crossCheckWiki(slug, data) {
  const mapping = wikiMappings.get(slug);
  if (!mapping) return { verdict: 'no-mapping', issues: ['no Wikipedia article mapping for this slug'] };

  let wikitext = null;
  let usedArticle = null;
  for (const { project, article } of mapping.attempts) {
    wikitext = await getWikitext(project, article, { refresh: opts.refresh });
    if (wikitext) {
      usedArticle = `${project}:${article}`;
      break;
    }
  }
  if (!wikitext) {
    return { verdict: 'no-wikitext', issues: [`no article found, tried: ${mapping.attempts.map((a) => `${a.project}:${a.article}`).join(', ')}`] };
  }
  const { rows, sectionKeys } = extractPublicationRows(wikitext);
  if (rows.length < 3) {
    return { verdict: 'no-table', issues: [`could not parse a publication list from ${usedArticle} (${rows.length} rows)`] };
  }

  const coreBooks = data.books.filter((b) => b.type !== 'powiązane');
  const issues = [];
  let matched = 0;
  const rowDetails = [];
  const rowVariants = new Map(rows.map((r) => [r, titleVariants(r.title)]));

  for (const book of coreBooks) {
    // Try both the original and the Polish title — PL articles list Polish
    // titles, EN articles list English ones.
    const bookVariants = [...titleVariants(book.titleOriginal ?? book.title), ...titleVariants(book.title)];
    const scored = [];
    let maxScore = 0;
    for (const row of rows) {
      let score = titleScore(bookVariants, rowVariants.get(row));
      if (sectionKeys.has(normalizeTitle(row.title).join(' '))) score += 0.05; // publication-section bonus
      if (score < MATCH_THRESHOLD) continue;
      const yearDelta = row.year == null ? Infinity : Math.abs(row.year - book.yearOriginal);
      scored.push({ row, score, yearDelta });
      maxScore = Math.max(maxScore, score);
    }
    // Among close-scoring rows prefer the one with the nearest year, so a
    // 2020 film link does not steal the match from the 1965 novel row.
    let best = null;
    let bestYearDelta = Infinity;
    for (const s of scored) {
      if (s.score < maxScore - 0.1) continue;
      // `<=` so year-less rows (all Infinity) still produce a match
      if (s.yearDelta <= bestYearDelta) {
        best = s.row;
        bestYearDelta = s.yearDelta;
      }
    }
    if (best) {
      matched += 1;
      rowDetails.push({ json: book.title, wiki: best.title, matched: true, delta: bestYearDelta });
      if (best.year != null && bestYearDelta > 1) {
        issues.push(`year differs for "${book.title}": ours ${book.yearOriginal}, wiki ${best.year}`);
      }
    } else {
      rowDetails.push({ json: book.title, wiki: null, matched: false });
      issues.push(`no Wikipedia match for "${book.titleOriginal ?? book.title}"`);
    }
  }

  const ratio = coreBooks.length > 0 ? matched / coreBooks.length : 1;
  let verdict;
  if (ratio >= 0.9 && issues.filter((i) => i.startsWith('no Wikipedia')).length === 0) verdict = 'verified';
  else if (ratio >= 0.9) verdict = 'partial';
  else if (ratio >= 0.6) verdict = 'partial';
  else verdict = 'false';

  const usedTitles = new Set(rowDetails.filter((r) => r.wiki).map((r) => r.wiki));
  const extraRows = rows
    .filter((r) => !usedTitles.has(r.title))
    .slice(0, 10)
    .map((r) => (r.year == null ? r.title : `${r.title} (${r.year})`));
  if (extraRows.length > 0) issues.push(`wiki rows not in our list (may be novellas/companions): ${extraRows.join('; ')}`);

  return {
    verdict,
    ratio,
    article: usedArticle,
    issues,
    rowDetails,
  };
}

// ---------- Debug helper ----------
// Print extracted Wikipedia rows for one slug and exit.
// Usage: node scripts/verify-series.mjs --debug-rows <slug>
if (opts.debugRows) {
  const mapping = wikiMappings.get(opts.debugRows);
  if (!mapping) {
    console.error(`no mapping for ${opts.debugRows}`);
    process.exit(1);
  }
  const { project, article } = mapping.attempts[0];
  const wikitext = await getWikitext(project, article, { refresh: opts.refresh });
  const { rows, sectionKeys } = extractPublicationRows(wikitext ?? '');
  console.log(`article: ${project}:${article}, rows: ${rows.length}`);
  for (const r of rows.slice(0, 60)) {
    const inSection = sectionKeys.has(normalizeTitle(r.title).join(' ')) ? '[S]' : '   ';
    console.log(`  ${inSection} ${r.title} | ${r.year}`);
  }
  process.exit(0);
}

// ---------- Run over selected files ----------

const allFiles = (await readdir(SERIES_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
let slugs;
if (opts.slugs) slugs = opts.slugs;
else if (opts.baseline) slugs = existingSeries.map((s) => s.slug);
else slugs = allFiles;

const pool = createPool(4, 100);
const reportRows = [];
const details = [];

for (const slug of slugs) {
  const filePath = path.join(SERIES_DIR, `${slug}.json`);
  const raw = await readJsonOrNull(filePath);
  if (!raw) {
    reportRows.push({ slug, local: 'FAIL', errors: [`file missing or invalid JSON: ${filePath}`], warnings: [], wiki: null });
    continue;
  }
  const { errors, warnings } = checkSeriesLocal(slug, raw);
  let wiki = null;
  if (!opts.skipWiki && errors.length === 0) {
    wiki = await pool(() => crossCheckWiki(slug, raw));
  }
  reportRows.push({ slug, local: errors.length === 0 ? 'OK' : 'FAIL', errors, warnings, wiki });
}

// Cross-file: one author string must map to one authorSlug.
const authorMap = new Map();
for (const slug of slugs) {
  const raw = await readJsonOrNull(path.join(SERIES_DIR, `${slug}.json`));
  if (!raw?.author) continue;
  const prev = authorMap.get(raw.author);
  if (prev && prev !== raw.authorSlug) {
    const row = reportRows.find((r) => r.slug === slug);
    row.errors.push(`author "${raw.author}" has conflicting authorSlug (${prev} vs ${raw.authorSlug})`);
    row.local = 'FAIL';
  }
  authorMap.set(raw.author, raw.authorSlug);
}
// relatedSeries targets must exist.
for (const slug of slugs) {
  const raw = await readJsonOrNull(path.join(SERIES_DIR, `${slug}.json`));
  for (const target of raw?.relatedSeries ?? []) {
    if (!allFiles.includes(target)) {
      const row = reportRows.find((r) => r.slug === slug);
      row.errors.push(`relatedSeries target "${target}" does not exist`);
      row.local = 'FAIL';
    }
  }
}

// ---------- Report ----------

const today = new Date().toISOString().slice(0, 10);
const verdictRank = { verified: 0, partial: 1, false: 2, 'no-mapping': 3, 'no-wikitext': 3, 'no-table': 3 };
const sortedRows = [...reportRows].sort(
  (a, b) =>
    (a.local === 'OK') - (b.local === 'OK') ||
    (verdictRank[b.wiki?.verdict ?? 3] ?? 3) - (verdictRank[a.wiki?.verdict ?? 3] ?? 3) ||
    a.slug.localeCompare(b.slug),
);

let md = `# Weryfikacja serii — ${today}\n\n`;
md += `Sprawdzone serie: ${reportRows.length}. Tryb: ${opts.skipWiki ? 'lokalny' : 'lokalny + Wikipedia'}.\n\n`;
md += `| Slug | Lokalnie | Wikipedia | Dopasowanie | Problemy |\n|---|---|---|---|---|\n`;
for (const r of sortedRows) {
  const wikiCell = r.wiki ? r.wiki.verdict : '—';
  const problemCount = r.errors.length + r.warnings.length + (r.wiki?.issues.length ?? 0);
  md += `| ${r.slug} | ${r.local} | ${wikiCell} | ${r.wiki?.ratio != null ? Math.round(r.wiki.ratio * 100) + '%' : '—'} | ${problemCount} |\n`;
}

const failing = sortedRows.filter((r) => r.local === 'FAIL');
const manual = sortedRows.filter((r) => r.wiki && r.wiki.verdict !== 'verified');

if (failing.length > 0) {
  md += `\n## Błędy lokalne (blokują)\n`;
  for (const r of failing) {
    md += `\n### ${r.slug}\n`;
    for (const e of r.errors) md += `- ❌ ${e}\n`;
  }
}

if (manual.length > 0) {
  md += `\n## Do przeglądu (weryfikacja Wikipedia)\n`;
  for (const r of manual) {
    md += `\n### ${r.slug} — ${r.wiki.verdict}${r.wiki.article ? ` (${r.wiki.article})` : ''}\n`;
    for (const i of r.wiki.issues.slice(0, 15)) md += `- ⚠️ ${i}\n`;
    if (r.wiki.rowDetails) {
      md += `\n| nasz tytuł | Wikipedia | Δ roku |\n|---|---|---|\n`;
      for (const d of r.wiki.rowDetails) {
        const delta = d.matched ? (Number.isFinite(d.delta) ? d.delta : '—') : '';
        md += `| ${d.json} | ${d.matched ? d.wiki : '— BRAK —'} | ${delta} |\n`;
      }
    }
  }
}

const warnedOnly = sortedRows.filter((r) => r.local === 'OK' && r.warnings.length > 0 && (!r.wiki || r.wiki.verdict === 'verified'));
if (warnedOnly.length > 0) {
  md += `\n## Ostrzeżenia (nieblokujące)\n`;
  for (const r of warnedOnly) {
    md += `\n### ${r.slug}\n`;
    for (const w of r.warnings) md += `- ⚠️ ${w}\n`;
  }
}

const outDir = path.join(DATA_DIR, 'verification');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `report-${today}.md`), md, 'utf8');
await writeFile(
  path.join(outDir, 'latest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), rows: reportRows }, null, 2),
  'utf8',
);

// ---------- Console summary + exit code ----------

const hardFailures = reportRows.filter((r) => r.local === 'FAIL').length;
const verified = reportRows.filter((r) => r.wiki?.verdict === 'verified').length;
const partial = reportRows.filter((r) => r.wiki?.verdict === 'partial').length;
const needsEyes = reportRows.filter((r) => r.wiki && !['verified', 'partial'].includes(r.wiki.verdict)).length;

console.log(`Serii: ${reportRows.length} | lokalnie OK: ${reportRows.length - hardFailures} | wiki verified: ${verified} | partial: ${partial} | do ręcznej rewizji: ${needsEyes}`);
console.log(`Raport: scripts/data/verification/report-${today}.md`);

if (hardFailures > 0) {
  console.error(`\n${hardFailures} serie z twardymi błędami lokalnymi — popraw przed commitem.`);
  process.exit(1);
}
