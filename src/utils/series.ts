import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export type SeriesEntry = CollectionEntry<'series'>;

export async function getAllSeries(): Promise<SeriesEntry[]> {
  const series = await getCollection('series');
  return series.sort((a, b) => a.data.title.localeCompare(b.data.title, 'pl'));
}

export function getAllAuthors(series: SeriesEntry[]): Map<string, { name: string; slug: string; seriesCount: number }> {
  const authors = new Map<string, { name: string; slug: string; seriesCount: number }>();
  for (const s of series) {
    const existing = authors.get(s.data.authorSlug);
    if (existing) {
      existing.seriesCount++;
    } else {
      authors.set(s.data.authorSlug, { name: s.data.author, slug: s.data.authorSlug, seriesCount: 1 });
    }
  }
  return authors;
}

export function getAllGenres(series: SeriesEntry[]): Map<string, number> {
  const genres = new Map<string, number>();
  for (const s of series) {
    for (const g of s.data.genre) {
      genres.set(g, (genres.get(g) || 0) + 1);
    }
  }
  return genres;
}

export function getSeriesByAuthor(series: SeriesEntry[], authorSlug: string): SeriesEntry[] {
  return series.filter((s) => s.data.authorSlug === authorSlug);
}

export function getSeriesByGenre(series: SeriesEntry[], genre: string): SeriesEntry[] {
  return series.filter((s) => s.data.genre.includes(genre));
}

export function getRelatedSeries(series: SeriesEntry[], slugs: string[]): SeriesEntry[] {
  return series.filter((s) => slugs.includes(s.id));
}
