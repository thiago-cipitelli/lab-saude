import sanitizeHtml from 'sanitize-html';

const WP_API = 'https://www.saude.ind.br/wp-json/wp/v2';

interface WpRendered {
  rendered: string;
}

export interface WpPost {
  id: number;
  slug: string;
  date: string;
  modified: string;
  title: WpRendered;
  excerpt: WpRendered;
  content: WpRendered;
  _embedded?: {
    'wp:featuredmedia'?: Array<{ source_url?: string; alt_text?: string }>;
  };
}

// A tipografia do site novo é 100% responsabilidade do nosso CSS: só sobram
// tags semânticas, sem style/class/id vindos do editor do WordPress.
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'h2', 'h3', 'h4', 'a', 'ul', 'ol', 'li', 'strong', 'em', 'br',
    'blockquote', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody',
    'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  },
  transformTags: {
    // h1 dentro do corpo vira h2 — o h1 da página é o título do post
    h1: 'h2',
    img: sanitizeHtml.simpleTransform('img', {
      loading: 'lazy',
      decoding: 'async',
    }),
  },
};

export function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#821[67];/g, "'")
    .replace(/&#822[01];/g, '"')
    .replace(/&#8230;|&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ');
}

export function sanitizePostContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTS);
}

export function excerptToText(html: string): string {
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(text)
    .replace(/\[…\]|\[&hellip;\]/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchAllWpPosts(): Promise<WpPost[]> {
  const posts: WpPost[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${WP_API}/posts?per_page=100&page=${page}&_embed=wp:featuredmedia`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(
        `Blog: falha de rede ao buscar ${url} — a API do WordPress (saude.ind.br) está acessível? ` +
          `O build depende dela para gerar o blog. Erro original: ${err}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `Blog: a API do WordPress respondeu ${res.status} em ${url}. ` +
          `Build interrompido de propósito — melhor falhar do que publicar o blog vazio.`,
      );
    }
    totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    posts.push(...((await res.json()) as WpPost[]));
    page += 1;
  } while (page <= totalPages);

  return posts;
}
