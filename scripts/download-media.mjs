#!/usr/bin/env node
/**
 * download-media.mjs
 *
 * Baixa toda a biblioteca de mídia (REST API /wp-json/wp/v2/media) e os assets
 * do tema ativo de um site WordPress, para uso em um projeto Astro.
 *
 * - Idempotente: arquivos já presentes (tamanho > 0) são pulados; pode ser
 *   re-executado com segurança.
 * - Reutilizável: parametrize BASE_URL / THEME_SLUG abaixo (ou via env vars
 *   WP_BASE_URL / WP_THEME_SLUG) para replicar em outros sites WP.
 * - Throttle de ~250ms entre requests HTTP, user-agent de navegador comum.
 *
 * Saídas:
 *   src/assets/wp/                  -> mídia original (nome de arquivo preservado,
 *                                      colisões deduplicadas com sufixo -<id>)
 *   src/assets/wp/media-manifest.json
 *   src/assets/theme/               -> assets do tema (estrutura de subpastas preservada)
 *
 * Nota: além da REST API (que omite attachments de posts não publicados/privados
 * para clientes anônimos), a home é varrida por URLs de /wp-content/uploads/
 * usadas nas páginas públicas mas invisíveis na API; essas entram no manifest
 * com id: null e source: "page-scan".
 *
 * Uso: node scripts/download-media.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';

// ----------------------------- CONFIG --------------------------------------
const BASE_URL = (process.env.WP_BASE_URL ?? 'https://www.saude.ind.br').replace(/\/+$/, '');
const THEME_SLUG = process.env.WP_THEME_SLUG ?? null; // null = autodetectar pela home
const PROJECT_ROOT = process.cwd();
const WP_DIR = path.join(PROJECT_ROOT, 'src/assets/wp');
const THEME_DIR = path.join(PROJECT_ROOT, 'src/assets/theme');
const MANIFEST_PATH = path.join(WP_DIR, 'media-manifest.json');
const THROTTLE_MS = 250;
const PER_PAGE = 100;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
// ----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function throttledFetch(url, attempt = 1) {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      redirect: 'follow',
    });
    if (!res.ok && res.status >= 500 && attempt < 3) {
      await sleep(1000 * attempt);
      return throttledFetch(url, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return throttledFetch(url, attempt + 1);
    }
    throw err;
  }
}

async function fileNonEmpty(filePath) {
  try {
    const st = await fs.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Baixa `url` para `destPath`. Retorna 'skipped' | 'downloaded'. Lança em erro. */
async function downloadFile(url, destPath) {
  if (await fileNonEmpty(destPath)) return 'skipped';
  const res = await throttledFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`Resposta vazia (0 bytes) em ${url}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, destPath);
  return 'downloaded';
}

// ------------------------- 1. MÍDIA (REST API) ------------------------------

async function fetchAllMedia() {
  const items = [];
  let totalPages = 1;
  let headerTotal = 0;
  for (let page = 1; page <= totalPages; page++) {
    const url = `${BASE_URL}/wp-json/wp/v2/media?per_page=${PER_PAGE}&page=${page}&orderby=id&order=asc`;
    const res = await throttledFetch(url);
    if (!res.ok) throw new Error(`Falha ao listar mídia (HTTP ${res.status}): ${url}`);
    totalPages = parseInt(res.headers.get('x-wp-totalpages') ?? '1', 10) || 1;
    headerTotal = parseInt(res.headers.get('x-wp-total') ?? '0', 10) || 0;
    const batch = await res.json();
    items.push(...batch);
    console.log(`[media] página ${page}/${totalPages}: ${batch.length} itens`);
  }
  if (headerTotal && items.length !== headerTotal) {
    // Comum em WP: X-WP-Total conta todos os attachments do banco, mas itens
    // anexados a posts não publicados/privados são filtrados após a paginação
    // para clientes não autenticados. Os N itens retornados são o conjunto
    // completo acessível publicamente.
    console.warn(
      `[media] AVISO: X-WP-Total=${headerTotal}, mas apenas ${items.length} itens visíveis sem autenticação (restante filtrado pelo WP).`
    );
  }
  return items;
}

function baseNameFromUrl(rawUrl) {
  const u = new URL(rawUrl, BASE_URL);
  return decodeURIComponent(u.pathname.split('/').pop() || 'arquivo');
}

/** Atribui nomes de arquivo determinísticos, deduplicando colisões com -<id>. */
function assignFileNames(items) {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const taken = new Set();
  const plan = [];
  for (const item of sorted) {
    const src = item.source_url;
    if (!src) {
      console.warn(`[media] item ${item.id} sem source_url — pulando`);
      continue;
    }
    let name = baseNameFromUrl(src);
    if (taken.has(name.toLowerCase())) {
      const ext = path.extname(name);
      name = `${name.slice(0, name.length - ext.length)}-${item.id}${ext}`;
    }
    taken.add(name.toLowerCase());
    plan.push({
      id: item.id,
      file: name,
      alt: item.alt_text ?? '',
      url: src,
      mime: item.mime_type ?? '',
    });
  }
  return plan;
}

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
};

/**
 * Varre um HTML por URLs de /wp-content/uploads/. A REST API omite attachments
 * de posts não publicados/privados, mas os arquivos continuam publicamente
 * servidos e usados nas páginas. Retorna [{file, url}] dedupado por basename.
 */
function collectUploadRefs(html) {
  const found = new Map(); // basename(lower) -> {file, url}
  const re = /https?:\/\/[^"'\s\\)<>]*\/wp-content\/uploads\/[^"'\s\\)<>]+/gi;
  for (const m of html.matchAll(re)) {
    const abs = normalizeAssetUrl(m[0].replace(/&#0?38;/g, '&').replace(/&amp;/g, '&'), BASE_URL + '/');
    if (!abs) continue;
    let base;
    try {
      base = decodeURIComponent(new URL(abs).pathname.split('/').pop() || '');
    } catch {
      continue;
    }
    if (!base) continue;
    const lower = base.toLowerCase();
    if (!found.has(lower)) found.set(lower, { file: base, url: abs });
  }
  return [...found.values()];
}

/** Links internos (mesma origem, não-asset) da home, para crawl de profundidade 1. */
function collectInternalPageUrls(html, limit = 60) {
  const origin = new URL(BASE_URL).origin;
  const urls = new Set();
  const $ = load(html);
  $('a[href]').each((_, el) => {
    const abs = normalizeAssetUrl($(el).attr('href'), BASE_URL + '/');
    if (!abs) return;
    let u;
    try {
      u = new URL(abs);
    } catch {
      return;
    }
    if (u.origin !== origin) return;
    if (u.pathname.includes('/wp-content/') || u.pathname.includes('/wp-json/')) return;
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|css|js|ico)$/i.test(u.pathname)) return;
    urls.add(u.href);
  });
  return [...urls].slice(0, limit);
}

/** Retira o sufixo de tamanho do WP (-800x600.ext); null se não houver. */
function stripSizeSuffix(name) {
  const m = name.match(/^(.+)-\d{2,4}x\d{2,4}(\.[a-z0-9]+)$/i);
  return m ? m[1] + m[2] : null;
}

// ------------------------- 2. ASSETS DO TEMA --------------------------------

function detectThemeSlug(html) {
  if (THEME_SLUG) return THEME_SLUG;
  const counts = new Map();
  for (const m of html.matchAll(/\/wp-content\/themes\/([a-z0-9_-]+)\//gi)) {
    const slug = m[1].toLowerCase();
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error('Não foi possível autodetectar o slug do tema.');
  return best[0];
}

function normalizeAssetUrl(raw, baseForRelative) {
  if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return null;
  let abs;
  try {
    abs = new URL(raw, baseForRelative);
  } catch {
    return null;
  }
  abs.hash = '';
  abs.search = ''; // remove ?ver=... etc.
  return abs.href;
}

/** Coleta URLs do tema no HTML da home (atributos + regex bruto). */
function collectThemeUrlsFromHtml(html, themePathFragment) {
  const urls = new Set();
  const $ = load(html);
  const push = (raw) => {
    const abs = normalizeAssetUrl(raw, BASE_URL + '/');
    if (abs && abs.includes(themePathFragment)) urls.add(abs);
  };
  $('[href]').each((_, el) => push($(el).attr('href')));
  $('[src]').each((_, el) => push($(el).attr('src')));
  $('[srcset]').each((_, el) => {
    for (const part of ($(el).attr('srcset') ?? '').split(','))
      push(part.trim().split(/\s+/)[0]);
  });
  $('meta[content]').each((_, el) => push($(el).attr('content')));
  // varredura bruta (inline styles, JSON embutido, etc.)
  const re = new RegExp(
    `(?:https?:)?(?://[^/"'\\s]+)?${themePathFragment.replace(/[/.]/g, '\\$&')}[^"'\\s)>\\\\]+`,
    'gi'
  );
  for (const m of html.matchAll(re)) push(m[0]);
  return urls;
}

/** Extrai url(...) e @import de um CSS, resolvendo relativos contra cssUrl. */
function collectUrlsFromCss(cssText, cssUrl, themePathFragment) {
  const urls = new Set();
  const push = (raw) => {
    const abs = normalizeAssetUrl(raw.trim().replace(/^['"]|['"]$/g, ''), cssUrl);
    if (abs && abs.includes(themePathFragment)) urls.add(abs);
  };
  for (const m of cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) push(m[2]);
  for (const m of cssText.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/gi)) push(m[1]);
  return urls;
}

function themeLocalPath(absUrl, themePathFragment) {
  const u = new URL(absUrl);
  const idx = u.pathname.indexOf(themePathFragment);
  const rel = decodeURIComponent(u.pathname.slice(idx + themePathFragment.length));
  return path.join(THEME_DIR, rel.replace(/^\/+/, ''));
}

// --------------------- 3. CORES DA MARCA (CSS) ------------------------------

function normalizeHex(hex) {
  let h = hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + [...h.slice(1)].map((c) => c + c).join('');
  return h;
}

/** Mapeia cor -> ocorrências {selector, prop, file} a partir de CSS. */
function extractColors(cssText, fileLabel, acc) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ').slice(0, 120);
    for (const decl of m[2].split(';')) {
      const [prop, ...valParts] = decl.split(':');
      const value = valParts.join(':');
      if (!prop || !value) continue;
      for (const hm of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        const hex = normalizeHex(hm[0]);
        if (!acc.has(hex)) acc.set(hex, []);
        acc.get(hex).push({ selector, prop: prop.trim(), file: fileLabel });
      }
    }
  }
}

// ------------------------------- MAIN ---------------------------------------

async function main() {
  await fs.mkdir(WP_DIR, { recursive: true });
  await fs.mkdir(THEME_DIR, { recursive: true });

  const failed = [];

  // --- Mídia -----------------------------------------------------------------
  console.log(`\n=== Mídia WordPress: ${BASE_URL} ===`);
  const mediaItems = await fetchAllMedia();
  console.log(`[media] total de itens na API: ${mediaItems.length}`);
  const manifest = assignFileNames(mediaItems);

  let mediaDownloaded = 0;
  let mediaSkipped = 0;
  const okManifest = [];
  for (const entry of manifest) {
    const dest = path.join(WP_DIR, entry.file);
    try {
      const status = await downloadFile(entry.url, dest);
      if (status === 'downloaded') {
        mediaDownloaded++;
        console.log(`[media] baixado: ${entry.file}`);
      } else {
        mediaSkipped++;
      }
      okManifest.push(entry);
    } catch (err) {
      console.error(`[media] FALHA id=${entry.id} ${entry.url}: ${err.message}`);
      failed.push(entry.url);
    }
  }
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(okManifest, null, 2) + '\n');
  console.log(
    `[media] novos: ${mediaDownloaded} | já existentes: ${mediaSkipped} | falhas: ${manifest.length - okManifest.length}`
  );
  console.log(`[media] manifest: ${MANIFEST_PATH} (${okManifest.length} entradas)`);

  // --- Tema --------------------------------------------------------------------
  console.log(`\n=== Assets do tema ===`);
  const homeRes = await throttledFetch(`${BASE_URL}/`);
  if (!homeRes.ok) throw new Error(`Falha ao buscar a home (HTTP ${homeRes.status})`);
  const homeHtml = await homeRes.text();
  const themeSlug = detectThemeSlug(homeHtml);
  const themePathFragment = `/wp-content/themes/${themeSlug}/`;
  console.log(`[theme] slug detectado: ${themeSlug}`);

  const themeUrls = collectThemeUrlsFromHtml(homeHtml, themePathFragment);
  console.log(`[theme] URLs no HTML da home: ${themeUrls.size}`);

  // Fila: baixa cada URL; se for .css, escaneia por mais URLs (backgrounds, fonts).
  const queue = [...themeUrls];
  const seen = new Set(queue);
  const themeFiles = [];
  const colorAcc = new Map();
  let themeDownloaded = 0;
  let themeSkipped = 0;

  while (queue.length > 0) {
    const url = queue.shift();
    const dest = themeLocalPath(url, themePathFragment);
    const isCss = dest.toLowerCase().endsWith('.css');
    try {
      const status = await downloadFile(url, dest);
      status === 'downloaded' ? themeDownloaded++ : themeSkipped++;
      themeFiles.push(dest);
      console.log(`[theme] ${status === 'downloaded' ? 'baixado' : 'ok (existia)'}: ${path.relative(PROJECT_ROOT, dest)}`);
      if (isCss) {
        const cssText = await fs.readFile(dest, 'utf8');
        extractColors(cssText, path.basename(dest), colorAcc);
        for (const found of collectUrlsFromCss(cssText, url, themePathFragment)) {
          if (!seen.has(found)) {
            seen.add(found);
            queue.push(found);
          }
        }
      }
    } catch (err) {
      console.error(`[theme] FALHA ${url}: ${err.message}`);
      failed.push(url);
    }
  }
  console.log(`[theme] novos: ${themeDownloaded} | já existentes: ${themeSkipped}`);

  // --- Uploads referenciados em páginas mas invisíveis na REST API -------------
  // Crawl de profundidade 1: home + páginas internas linkadas nela.
  console.log(`\n=== Uploads referenciados em páginas (fora da REST API) ===`);
  const pageUrls = [`${BASE_URL}/`, ...collectInternalPageUrls(homeHtml)];
  const htmls = new Map([[`${BASE_URL}/`, homeHtml]]);
  for (const pageUrl of pageUrls) {
    if (htmls.has(pageUrl)) continue;
    try {
      const res = await throttledFetch(pageUrl);
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) continue;
      htmls.set(pageUrl, await res.text());
    } catch (err) {
      console.warn(`[page-scan] página inacessível (${err.message}): ${pageUrl}`);
    }
  }
  console.log(`[page-scan] páginas varridas: ${htmls.size}`);

  const covered = new Set(okManifest.map((e) => e.file.toLowerCase()));
  const addEntry = (file, url) => {
    okManifest.push({
      id: null,
      file,
      alt: '',
      url,
      mime: EXT_MIME[path.extname(file).toLowerCase()] ?? '',
      source: 'page-scan',
    });
    covered.add(file.toLowerCase());
  };
  let scanDownloaded = 0;
  let scanSkipped = 0;
  for (const html of htmls.values()) {
    for (const { file, url } of collectUploadRefs(html)) {
      const lower = file.toLowerCase();
      const stripped = stripSizeSuffix(file);
      if (covered.has(lower) || (stripped && covered.has(stripped.toLowerCase()))) continue;
      // variante -WxH sem original coberto: tenta primeiro o original
      if (stripped) {
        const origUrl = url.replace(/-\d{2,4}x\d{2,4}(\.[a-z0-9]+)$/i, '$1');
        try {
          const status = await downloadFile(origUrl, path.join(WP_DIR, stripped));
          status === 'downloaded' ? scanDownloaded++ : scanSkipped++;
          addEntry(stripped, origUrl);
          console.log(`[page-scan] ${status === 'downloaded' ? 'baixado' : 'ok (existia)'}: ${stripped} (original de ${file})`);
          continue;
        } catch {
          /* original indisponível — cai para a variante */
        }
      }
      try {
        const status = await downloadFile(url, path.join(WP_DIR, file));
        status === 'downloaded' ? scanDownloaded++ : scanSkipped++;
        addEntry(file, url);
        console.log(`[page-scan] ${status === 'downloaded' ? 'baixado' : 'ok (existia)'}: ${file}`);
      } catch (err) {
        console.error(`[page-scan] FALHA ${url}: ${err.message}`);
        failed.push(url);
      }
    }
  }
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(okManifest, null, 2) + '\n');
  console.log(
    `[page-scan] novos: ${scanDownloaded} | já existentes: ${scanSkipped} | manifest atualizado: ${okManifest.length} entradas`
  );

  // --- Relatório de cores --------------------------------------------------------
  const colorReport = [...colorAcc.entries()]
    .map(([hex, uses]) => {
      const contexts = new Map();
      for (const u of uses) {
        const key = `${u.file} :: ${u.selector} { ${u.prop} }`;
        contexts.set(key, (contexts.get(key) ?? 0) + 1);
      }
      return {
        hex,
        count: uses.length,
        siteSpecificCount: uses.filter((u) => !/^(normalize|webflow)\.css$/.test(u.file)).length,
        contexts: [...contexts.keys()].slice(0, 12),
      };
    })
    .sort((a, b) => b.siteSpecificCount - a.siteSpecificCount || b.count - a.count);
  console.log('\n=== CORES ENCONTRADAS NO CSS DO TEMA ===');
  console.log(JSON.stringify(colorReport.slice(0, 25), null, 2));

  // --- Verificação final ------------------------------------------------------------
  console.log('\n=== Verificação final ===');
  const zeroByte = [];
  for (const dir of [WP_DIR, THEME_DIR]) {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = path.join(e.parentPath ?? e.path, e.name);
      const st = await fs.stat(p);
      if (st.size === 0) {
        zeroByte.push(p);
        await fs.unlink(p);
        console.error(`[check] arquivo 0 bytes removido: ${p}`);
      }
    }
  }
  for (const p of zeroByte) failed.push(`0-bytes:${p}`);

  const wpEntries = (await fs.readdir(WP_DIR, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name !== 'media-manifest.json');
  const wpFileCount = wpEntries.length;
  const themeEntries = (await fs.readdir(THEME_DIR, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile());

  const summary = {
    baseUrl: BASE_URL,
    themeSlug,
    mediaApiTotal: mediaItems.length,
    manifestEntries: okManifest.length,
    wpFilesOnDisk: wpFileCount,
    wpCountMatches: wpFileCount === okManifest.length,
    mediaNewDownloads: mediaDownloaded,
    themeFilesOnDisk: themeEntries.length,
    themeFiles: themeEntries.map((e) => path.relative(PROJECT_ROOT, path.join(e.parentPath ?? e.path, e.name))).sort(),
    failed,
  };
  console.log('\n=== RESUMO ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.wpCountMatches) {
    console.error('[check] ATENÇÃO: contagem de arquivos em src/assets/wp não bate com o manifest!');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
