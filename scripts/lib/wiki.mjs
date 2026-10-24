// Wikipedia access layer: pageviews (Wikimedia REST), redirect resolution and
// wikitext fetch (Action API), all backed by a JSON file cache under
// scripts/data/cache/ with a 7-day TTL.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './http.mjs';

const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CACHE_DIR = path.join(SCRIPTS_DIR, 'data', 'cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const API_HOSTS = {
  en: 'https://en.wikipedia.org',
  pl: 'https://pl.wikipedia.org',
};

function articleToUrlTitle(article) {
  return article.trim().replaceAll(' ', '_');
}

async function cachedFetch(relPath, producer, { refresh = false } = {}) {
  const abs = path.join(CACHE_DIR, relPath);
  if (!refresh && existsSync(abs)) {
    const cached = JSON.parse(await readFile(abs, 'utf8'));
    if (Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
      return cached.payload;
    }
  }
  const payload = await producer();
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify({ fetchedAt: new Date().toISOString(), payload }, null, 2), 'utf8');
  return payload;
}

// Monthly pageviews for one article over [fromYM..toYM] (inclusive, "YYYY-MM").
// Returns [{ timestamp: 'YYYY-MM', views }] or null when the article has no data
// (typical for a wrong/redirect title — the REST API does not follow redirects).
export async function getPageviews(project, article, fromYM, toYM, { refresh = false } = {}) {
  const [ty, tm] = toYM.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const from = `${fromYM.replace('-', '')}0100`;
  const to = `${toYM.replace('-', '')}${String(lastDay).padStart(2, '0')}00`;
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}.wikipedia` +
    `/all-access/user/${encodeURIComponent(articleToUrlTitle(article))}/monthly/${from}/${to}`;

  return cachedFetch(
    path.join('pageviews', project, `${articleToUrlTitle(article).replaceAll('/', '%2F')}.${fromYM}-${toYM}.json`),
    async () => {
      const { status, data } = await fetchJson(url);
      if (status === 404 || !data?.items || data.items.length === 0) return null;
      return data.items.map((item) => ({
        timestamp: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(4, 6)}`,
        views: item.views,
      }));
    },
    { refresh },
  );
}

// Resolve redirects and return the canonical title, or null when missing.
export async function resolveRedirect(project, article, { refresh = false } = {}) {
  const url =
    `${API_HOSTS[project]}/w/api.php?action=query&titles=${encodeURIComponent(article)}` +
    `&redirects=1&format=json&formatversion=2`;

  return cachedFetch(
    path.join('resolve', project, `${articleToUrlTitle(article).replaceAll('/', '%2F')}.json`),
    async () => {
      const { data } = await fetchJson(url);
      const page = data?.query?.pages?.[0];
      if (!page || page.missing) return null;
      return page.title;
    },
    { refresh },
  );
}

// Raw wikitext of an article (null when missing). Follows redirects.
export async function getWikitext(project, article, { refresh = false } = {}) {
  const url =
    `${API_HOSTS[project]}/w/api.php?action=parse&page=${encodeURIComponent(article)}` +
    `&redirects=1&prop=wikitext&format=json&formatversion=2`;

  return cachedFetch(
    path.join('wikitext', project, `${articleToUrlTitle(article).replaceAll('/', '%2F')}.json`),
    async () => {
      const { data } = await fetchJson(url);
      if (data?.error || !data?.parse?.wikitext) return null;
      return data.parse.wikitext;
    },
    { refresh },
  );
}
