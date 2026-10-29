// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import pagefind from 'astro-pagefind';

export default defineConfig({
  site: 'https://kolejnosc-czytania.pl',
  compressHTML: true,
  integrations: [
    sitemap(),
    pagefind(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
