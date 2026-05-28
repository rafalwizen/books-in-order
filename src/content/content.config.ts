import { defineCollection, z } from 'astro:content';

const seriesCollection = defineCollection({
  type: 'data',
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
