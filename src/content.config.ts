import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const seriesCollection = defineCollection({
  loader: glob({ pattern: '*.json', base: 'src/content/series' }),
  schema: z.object({
    title: z.string(),
    titleOriginal: z.string().optional(),
    author: z.string(),
    authorSlug: z.string(),
    genre: z.array(z.string()),
    description: z.string(),
    books: z.array(z.object({
      order: z.number(),
      title: z.string(),
      titleOriginal: z.string().optional(),
      yearOriginal: z.number(),
      yearPolish: z.number().optional(),
      type: z.enum(['powieść', 'opowiadanie', 'tom', 'powiązane']).default('powieść'),
    })),
    faq: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })),
    relatedSeries: z.array(z.string()).default([]),
  }),
});

export const collections = {
  series: seriesCollection,
};
