// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// URLs espelham o WordPress atual (/produtos/<slug>/, /blog/<slug>/) para
// preservar o ranking no Google quando o DNS apontar para a Vercel.
export default defineConfig({
  site: 'https://www.saude.ind.br',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  image: {
    // capas e imagens de corpo dos posts do blog continuam hospedadas no WP
    domains: ['www.saude.ind.br'],
  },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
