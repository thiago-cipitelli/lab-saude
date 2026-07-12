#!/usr/bin/env node
/**
 * scrape-produtos.mjs
 *
 * Extrai os produtos de um site WordPress (tema "tezus" / Webflow-like) e gera:
 *   - src/content/produtos/<slug>.md  (frontmatter YAML + corpo em Markdown)
 *   - src/assets/produtos/<slug>[.-N].<ext>  (imagens)
 *
 * Idempotente: pode ser re-executado; imagens já baixadas (>0 bytes) são
 * reaproveitadas e os .md são regravados de forma determinística.
 *
 * Reutilizável para outros sites WP: ajuste o bloco CONFIG abaixo.
 *
 * Uso:  node scripts/scrape-produtos.mjs
 */

import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import yaml from 'js-yaml';

/* ============================== CONFIG =================================== */

const BASE_URL = 'https://www.saude.ind.br'; // sem barra final
const THROTTLE_MS = 250;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// Caminho de URL que identifica uma página de produto -> captura o slug
const PRODUCT_PATH_RE = /\/produtos\/([^/?#]+)\/?$/;

// Sitemaps candidatos (ordem de tentativa). Fallback: links da home.
const SITEMAP_CANDIDATES = ['/sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml'];

// Seletores do tema (tezus). Ajuste para outros temas WP.
const SEL = {
  productTitle: 'h1.details-header-title',
  headerContent: '.details-header-content', // título + tagline
  headerImage: '.details-header-picture img.picture-show, .details-header-picture img',
  logoImage: '.details-logo img',
  sideImage: '.details-picture img',
  contentBlocks: '.details-content > .details-block', // seções (Descrição, Composição...)
  blockTitle: '.details-block-flex .details-block-title',
  // Home: abas de categoria com sliders de produto
  homeTabLinks: '.tabs-menu .tab-link',
  homeTabPanes: '.tabs-content > div',
  homeProductLink: 'a[href]',
};

// Seções sem copy útil (ex.: localizador de lojas) — puladas se vazias sempre;
// esta lista é pulada mesmo com conteúdo.
const SKIP_SECTIONS = new Set(['onde encontrar']);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'src', 'assets', 'produtos');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'src', 'content', 'produtos');
const IMAGE_REL_PREFIX = '../../assets/produtos'; // relativo aos .md

const KNOWN_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'];

/* =========================== HTTP (throttled) ============================ */

let lastRequestAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttledFetch(url, { asBuffer = false, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: asBuffer
            ? 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
        },
        redirect: 'follow',
      });
      if (res.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return { ok: false, status: res.status, url: res.url };
      const body = asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return {
        ok: true,
        status: res.status,
        url: res.url,
        body,
        contentType: res.headers.get('content-type') || '',
      };
    } catch (err) {
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { ok: false, status: 0, error: String(err) };
    }
  }
}

/* ========================== descoberta de slugs ========================== */

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

function productUrlsFrom(list) {
  const map = new Map(); // slug -> url (preserva ordem)
  for (const raw of list) {
    let u;
    try {
      u = new URL(raw, BASE_URL);
    } catch {
      continue;
    }
    const m = u.pathname.match(PRODUCT_PATH_RE);
    if (m && !map.has(m[1])) map.set(m[1], `${BASE_URL}${u.pathname}`);
  }
  return map;
}

async function discoverProducts() {
  for (const smPath of SITEMAP_CANDIDATES) {
    const res = await throttledFetch(`${BASE_URL}${smPath}`);
    if (!res.ok || !/<(urlset|sitemapindex)/i.test(res.body)) continue;
    const locs = extractLocs(res.body);
    // URLs de produto direto no sitemap?
    let products = productUrlsFrom(locs);
    if (products.size > 0) {
      console.log(`[descoberta] ${products.size} produtos via ${smPath}`);
      return products;
    }
    // índice de sitemaps: visita os filhos (prioriza os que mencionam "produto")
    const children = locs.filter((l) => /\.xml(\?|$)/.test(l));
    children.sort((a, b) => (b.includes('produto') ? 1 : 0) - (a.includes('produto') ? 1 : 0));
    for (const child of children) {
      const childRes = await throttledFetch(child);
      if (!childRes.ok) continue;
      products = productUrlsFrom(extractLocs(childRes.body));
      if (products.size > 0) {
        console.log(`[descoberta] ${products.size} produtos via ${child}`);
        return products;
      }
    }
  }
  // Fallback: links da home
  const home = await throttledFetch(`${BASE_URL}/`);
  if (home.ok) {
    const $ = cheerio.load(home.body);
    const hrefs = $('a[href]')
      .map((_, el) => $(el).attr('href'))
      .get();
    const products = productUrlsFrom(hrefs);
    if (products.size > 0) {
      console.log(`[descoberta] ${products.size} produtos via links da home`);
      return products;
    }
  }
  throw new Error('Nenhum produto descoberto (sitemap e home falharam).');
}

/* ================= categorias + ordem (abas da home) ===================== */

async function discoverCategoriesAndOrder() {
  const res = await throttledFetch(`${BASE_URL}/`);
  const bySlug = new Map(); // slug -> { category, order }
  if (!res.ok) return bySlug;
  const $ = cheerio.load(res.body);
  const tabNames = $(SEL.homeTabLinks)
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get();
  let order = 1;
  $(SEL.homeTabPanes).each((paneIdx, pane) => {
    const category = tabNames[paneIdx];
    $(pane)
      .find(SEL.homeProductLink)
      .each((_, a) => {
        const href = $(a).attr('href') || '';
        let u;
        try {
          u = new URL(href, BASE_URL);
        } catch {
          return;
        }
        const m = u.pathname.match(PRODUCT_PATH_RE);
        if (m && !bySlug.has(m[1])) bySlug.set(m[1], { category, order: order++ });
      });
  });
  console.log(`[home] abas: ${tabNames.join(', ')} | ${bySlug.size} produtos ordenados`);
  return bySlug;
}

/* ============================ HTML -> Markdown =========================== */

function cleanText(s) {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function inlineMd($, node) {
  let out = '';
  for (const child of $(node).contents().toArray()) {
    if (child.type === 'text') {
      out += child.data.replace(/ /g, ' ');
    } else if (child.type === 'tag') {
      const tag = child.tagName.toLowerCase();
      const inner = inlineMd($, child);
      if (tag === 'br') out += ' ';
      else if ((tag === 'strong' || tag === 'b') && cleanText(inner)) out += `**${cleanText(inner)}**`;
      else if ((tag === 'em' || tag === 'i') && cleanText(inner)) out += `*${cleanText(inner)}*`;
      else if (tag === 'img') out += '';
      else out += inner; // a, span, h3 dentro de li, etc. -> só o texto
    }
  }
  return out;
}

const MODO_USO_RE = /^modo de (uso|usar)\b\s*:?$/i;

function blockToMd($, container, paragraphs) {
  for (const child of $(container).contents().toArray()) {
    if (child.type === 'text') {
      const t = cleanText(child.data);
      if (t) paragraphs.push(t);
      continue;
    }
    if (child.type !== 'tag') continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const items = [];
      $(child)
        .children('li')
        .each((i, li) => {
          const t = cleanText(inlineMd($, li));
          if (t) items.push(tag === 'ol' ? `${i + 1}. ${t}` : `- ${t}`);
        });
      if (items.length) paragraphs.push(items.join('\n'));
    } else if (/^h[1-6]$/.test(tag) || tag === 'p') {
      const t = cleanText(inlineMd($, child));
      if (!t) continue;
      paragraphs.push(MODO_USO_RE.test(t) ? `**${t.replace(/:?$/, ':')}**` : t);
    } else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'span') {
      blockToMd($, child, paragraphs);
    } else if (tag === 'img' || tag === 'script' || tag === 'style') {
      // ignorado
    } else {
      const t = cleanText(inlineMd($, child));
      if (t) paragraphs.push(t);
    }
  }
}

function sectionHtmlToMd(html) {
  const clean = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'ul', 'ol', 'li', 'div', 'span', 'section', 'article',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'a'],
    allowedAttributes: {},
  });
  const $ = cheerio.load(`<root>${clean}</root>`);
  const paragraphs = [];
  blockToMd($, $('root'), paragraphs);
  return paragraphs.join('\n\n');
}

/* ======================== parse de página de produto ===================== */

function largestFromSrcset(srcset) {
  let best = null;
  let bestW = -1;
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    const w = d && /^\d+w$/.test(d) ? parseInt(d, 10) : 0;
    if (u && w >= bestW) {
      bestW = w;
      best = u;
    }
  }
  return best;
}

function normalizeImgUrl(u) {
  try {
    const url = new URL(u, BASE_URL);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

// chave para dedupe: remove sufixo -WxH do WordPress
function imgKey(u) {
  return u.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1').toLowerCase();
}

function collectImageCandidates($, el) {
  // ordem de preferência: maior do srcset > src sem -WxH > src original
  const out = [];
  const srcset = $(el).attr('srcset');
  if (srcset) {
    const big = normalizeImgUrl(largestFromSrcset(srcset));
    if (big) out.push(big);
  }
  const src = normalizeImgUrl($(el).attr('src'));
  if (src) {
    const stripped = src.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1');
    if (stripped !== src) out.push(stripped);
    out.push(src);
  }
  return [...new Set(out)];
}

function parseProductPage(html, url, slug) {
  const $ = cheerio.load(html);

  const title =
    cleanText($(SEL.productTitle).first().text()) ||
    cleanText($('meta[property="og:title"]').attr('content') || '').split('-')[0].trim();

  // tagline = texto do header sem o título
  const header = $(SEL.headerContent).first().clone();
  header.find(SEL.productTitle.split(',')[0]).remove();
  header.find('h1').remove();
  const tagline = cleanText(header.text());

  // seções de conteúdo
  const sections = [];
  $(SEL.contentBlocks).each((_, block) => {
    const $block = $(block);
    const name = cleanText($block.children('.details-block-flex').find('.details-block-title').text());
    if (!name) return; // blocos aninhados são serializados dentro do pai
    if (SKIP_SECTIONS.has(name.toLowerCase())) return;
    const clone = $block.clone();
    clone.children('.details-block-flex').remove();
    const md = sectionHtmlToMd($.html(clone));
    if (md) sections.push({ name, md });
  });

  // imagens: principal (header), logo, imagens inline do conteúdo, lateral
  const main = collectImageCandidates($, $(SEL.headerImage).first());
  const galleryCandidates = [];
  $(SEL.logoImage).each((_, el) => galleryCandidates.push(collectImageCandidates($, el)));
  $(SEL.contentBlocks).find('img').each((_, el) => galleryCandidates.push(collectImageCandidates($, el)));
  $(SEL.sideImage).each((_, el) => galleryCandidates.push(collectImageCandidates($, el)));

  // dedupe (inclusive contra a principal), preservando ordem
  const seen = new Set(main.map(imgKey));
  const gallery = [];
  for (const cands of galleryCandidates) {
    if (!cands.length) continue;
    const key = imgKey(cands[0]);
    if (seen.has(key) || cands.some((c) => seen.has(imgKey(c)))) continue;
    seen.add(key);
    gallery.push(cands);
  }

  const body = sections.map((s) => `## ${s.name}\n\n${s.md}`).join('\n\n');
  return { slug, url, title, tagline, body, mainCandidates: main, galleryCandidates: gallery };
}

/* =========================== download de imagens ========================= */

function extFromUrl(u) {
  const m = new URL(u).pathname.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : null;
  return ext && KNOWN_EXTS.includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : null;
}

function extFromContentType(ct) {
  const m = /image\/(png|jpe?g|webp|gif|svg\+xml|avif)/i.exec(ct || '');
  if (!m) return null;
  const t = m[1].toLowerCase();
  return t === 'jpeg' ? 'jpg' : t === 'svg+xml' ? 'svg' : t;
}

async function existingFile(baseName) {
  for (const ext of KNOWN_EXTS) {
    const p = path.join(ASSETS_DIR, `${baseName}.${ext}`);
    if (existsSync(p)) {
      const s = await stat(p);
      if (s.size > 0) return `${baseName}.${ext}`;
    }
  }
  return null;
}

/**
 * Baixa a primeira candidata que responder 200 e salva como <baseName>.<ext>.
 * Idempotente: se já existe arquivo >0 bytes com esse baseName, reutiliza.
 */
async function downloadImage(candidates, baseName) {
  const cached = await existingFile(baseName);
  if (cached) return { file: cached, cached: true };
  for (const url of candidates) {
    const res = await throttledFetch(url, { asBuffer: true });
    if (!res.ok || !res.body || res.body.length === 0) continue;
    const ext = extFromUrl(res.url || url) || extFromContentType(res.contentType) || 'png';
    const file = `${baseName}.${ext}`;
    await writeFile(path.join(ASSETS_DIR, file), res.body);
    return { file, cached: false, url };
  }
  return null;
}

/* ============================ geração dos .md ============================ */

const yq = (s) => JSON.stringify(String(s)); // string YAML segura (double-quoted)

function renderMarkdown(p) {
  const lines = ['---'];
  lines.push(`title: ${yq(p.title)}`);
  if (p.tagline) lines.push(`tagline: ${yq(p.tagline)}`);
  if (p.category) lines.push(`category: ${yq(p.category)}`);
  lines.push(`image: ${yq(`${IMAGE_REL_PREFIX}/${p.imageFile}`)}`);
  if (p.galleryFiles.length) {
    lines.push('gallery:');
    for (const g of p.galleryFiles) lines.push(`  - ${yq(`${IMAGE_REL_PREFIX}/${g}`)}`);
  } else {
    lines.push('gallery: []');
  }
  lines.push(`order: ${p.order}`);
  lines.push(`sourceUrl: ${yq(p.url)}`);
  lines.push('---', '');
  lines.push(p.body || '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ================================ validação ============================== */

async function validate() {
  const issues = [];
  const files = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith('.md'));
  for (const f of files) {
    const mdPath = path.join(CONTENT_DIR, f);
    const raw = await readFile(mdPath, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) {
      issues.push(`${f}: frontmatter ausente`);
      continue;
    }
    let fm;
    try {
      fm = yaml.load(m[1]);
    } catch (e) {
      issues.push(`${f}: YAML inválido (${e.message})`);
      continue;
    }
    if (!fm || typeof fm.title !== 'string' || !fm.title.trim()) issues.push(`${f}: title inválido`);
    if (typeof fm.order !== 'number') issues.push(`${f}: order inválido`);
    const refs = [fm.image, ...(Array.isArray(fm.gallery) ? fm.gallery : [])];
    for (const ref of refs) {
      if (typeof ref !== 'string') {
        issues.push(`${f}: referência de imagem inválida (${ref})`);
        continue;
      }
      const abs = path.resolve(CONTENT_DIR, ref);
      if (!existsSync(abs)) issues.push(`${f}: imagem inexistente ${ref}`);
      else if ((await stat(abs)).size === 0) issues.push(`${f}: imagem vazia ${ref}`);
    }
    const body = raw.slice(m[0].length).trim();
    if (!body) issues.push(`${f}: corpo vazio`);
  }
  return { files, issues };
}

/* ================================== main ================================= */

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(CONTENT_DIR, { recursive: true });

  const products = await discoverProducts(); // Map slug -> url
  const homeMeta = await discoverCategoriesAndOrder(); // Map slug -> {category, order}

  const results = [];
  let imagesDownloaded = 0;
  const problems = [];

  // ordem estável de processamento: ordem da home, depois alfabética
  const slugs = [...products.keys()].sort((a, b) => {
    const oa = homeMeta.get(a)?.order ?? 999;
    const ob = homeMeta.get(b)?.order ?? 999;
    return oa - ob || a.localeCompare(b);
  });

  let fallbackOrder = homeMeta.size;
  for (const slug of slugs) {
    const url = products.get(slug);
    console.log(`[produto] ${slug} <- ${url}`);
    const res = await throttledFetch(url);
    if (!res.ok) {
      problems.push(`${slug}: HTTP ${res.status || res.error} ao buscar página`);
      continue;
    }
    const parsed = parseProductPage(res.body, url, slug);
    if (!parsed.title) {
      problems.push(`${slug}: título não encontrado`);
      continue;
    }
    const meta = homeMeta.get(slug);
    parsed.category = meta?.category;
    parsed.order = meta?.order ?? ++fallbackOrder;

    // imagem principal
    if (!parsed.mainCandidates.length) {
      problems.push(`${slug}: nenhuma imagem principal encontrada`);
      continue;
    }
    const mainDl = await downloadImage(parsed.mainCandidates, slug);
    if (!mainDl) {
      problems.push(`${slug}: falha ao baixar imagem principal (${parsed.mainCandidates[0]})`);
      continue;
    }
    if (!mainDl.cached) imagesDownloaded++;
    parsed.imageFile = mainDl.file;

    // galeria
    parsed.galleryFiles = [];
    let n = 1;
    for (const cands of parsed.galleryCandidates) {
      const dl = await downloadImage(cands, `${slug}-${n}`);
      if (dl) {
        if (!dl.cached) imagesDownloaded++;
        parsed.galleryFiles.push(dl.file);
        n++;
      } else {
        problems.push(`${slug}: falha ao baixar imagem de galeria (${cands[0]})`);
      }
    }

    await writeFile(path.join(CONTENT_DIR, `${slug}.md`), renderMarkdown(parsed), 'utf8');
    results.push(parsed);
    console.log(
      `  -> ok: "${parsed.title}" [${parsed.category ?? 'sem categoria'}] ` +
        `img=${parsed.imageFile} galeria=${parsed.galleryFiles.length}`
    );
  }

  const { files, issues } = await validate();
  const summary = {
    baseUrl: BASE_URL,
    produtos: results.length,
    arquivosMd: files.length,
    imagensBaixadas: imagesDownloaded,
    categorias: [...new Set(results.map((r) => r.category).filter(Boolean))],
    slugs: results.map((r) => r.slug),
    problemas: [...problems, ...issues],
  };
  console.log('\n===== RESUMO =====');
  console.log(JSON.stringify(summary, null, 2));
  if (summary.problemas.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
