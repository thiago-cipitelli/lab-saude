import { defineCollection, z } from 'astro:content';
import { glob, file } from 'astro/loaders';
import {
  fetchAllWpPosts,
  decodeEntities,
  sanitizePostContent,
  excerptToText,
} from './lib/wp';

// Conteúdo extraído uma única vez do site atual e versionado no repositório
// (as páginas/produtos não são expostos pela REST API do cliente).
const produtos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/produtos' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      tagline: z.string().optional(),
      category: z.enum(['Cosméticos', 'Medicamentos', 'Alimentos']).optional(),
      image: image(),
      gallery: z.array(image()).default([]),
      order: z.number().default(99),
      sourceUrl: z.string().url().optional(),
    }),
});

const timeline = defineCollection({
  loader: file('./src/content/timeline/eventos.json', {
    parser: (text) =>
      JSON.parse(text).map((evento: Record<string, unknown>, i: number) => ({
        id: String(i).padStart(2, '0'),
        ...evento,
      })),
  }),
  schema: z.object({
    ano: z.coerce.string(),
    // O site de origem não tem título por evento; o scraper grava null por fidelidade.
    titulo: z.string().nullable(),
    texto: z.string(),
    imagem: z.string().nullable().optional(),
    // Evento de 1977 usa um slider com múltiplas fotos.
    imagens: z.array(z.string()).optional(),
  }),
});

// Único conteúdo vivo: o blog continua sendo editado pelo cliente no painel
// WordPress e é puxado pela REST API a cada build.
const blog = defineCollection({
  loader: async () => {
    const posts = await fetchAllWpPosts();
    return posts.map((post) => ({
      id: post.slug,
      title: decodeEntities(post.title.rendered),
      date: post.date,
      excerpt: excerptToText(post.excerpt.rendered),
      content: sanitizePostContent(post.content.rendered),
      cover: post._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null,
      coverAlt: post._embedded?.['wp:featuredmedia']?.[0]?.alt_text ?? '',
    }));
  },
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string(),
    content: z.string(),
    cover: z.string().nullable(),
    coverAlt: z.string(),
  }),
});

export const collections = { produtos, timeline, blog };
