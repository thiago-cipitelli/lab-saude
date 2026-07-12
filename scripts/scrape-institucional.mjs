#!/usr/bin/env node
/**
 * scrape-institucional.mjs
 *
 * Raspa as páginas institucionais de um site WordPress (tema "tezus" ou similar)
 * e gera JSONs estruturados com o COPY fiel (strings limpas, sem HTML) para o redesign.
 *
 * Saídas:
 *   - src/content/timeline/eventos.json  -> eventos da linha do tempo, ordenados por ano
 *   - src/data/institucional.json        -> home, quemSomos, sac, trabalheConosco, contato, lojaUrl
 *
 * Idempotente: pode ser re-executado; sempre sobrescreve as saídas com dados frescos.
 * Reutilizável: parametrize BASE_URL (e, se necessário, PATHS) para outros sites WP do grupo.
 *
 * Uso: node scripts/scrape-institucional.mjs [baseUrl]
 */

import { load } from 'cheerio';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuração (parametrizável para replicar em outros sites WP)
// ---------------------------------------------------------------------------
const BASE_URL = (process.argv[2] || 'https://www.saude.ind.br').replace(/\/+$/, '');

const PATHS = {
  home: '/',
  quemSomos: '/quem-somos/',
  linhaDoTempo: '/linha-do-tempo/',
  sac: '/sac/',
  trabalheConosco: '/trabalhe-conosco/',
};

const THROTTLE_MS = 250;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_TIMELINE = path.join(PROJECT_ROOT, 'src/content/timeline/eventos.json');
const OUT_INSTITUCIONAL = path.join(PROJECT_ROOT, 'src/data/institucional.json');

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function fetchHTML(pathname) {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const url = pathname.startsWith('http') ? pathname : BASE_URL + pathname;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const html = await res.text();
  console.log(`  ✔ ${url} (${(html.length / 1024).toFixed(1)} KB)`);
  return load(html);
}

/** Texto limpo: sem tags, entidades decodificadas (cheerio), espaços colapsados. */
function clean(text) {
  return (text || '')
    .replace(/ /g, ' ') // &nbsp;
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve URLs relativas contra a BASE_URL. */
function absUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, BASE_URL + '/').toString();
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// Parsers de blocos compartilhados (nav, sidebar de contato, redes sociais)
// ---------------------------------------------------------------------------
function parseLojaUrl($) {
  let loja = null;
  $('nav a, header a').each((_, el) => {
    if (clean($(el).text()).toLowerCase() === 'loja') loja = $(el).attr('href') || loja;
  });
  return loja;
}

function parseSocial($) {
  const redes = [];
  const seen = new Set();
  $('a.social-icon').each((_, el) => {
    const url = $(el).attr('href');
    if (!url || seen.has(url)) return;
    seen.add(url);
    let rede = 'outro';
    if (/fb\.com|facebook\.com/i.test(url)) rede = 'facebook';
    else if (/youtube\.com|youtu\.be/i.test(url)) rede = 'youtube';
    else if (/instagram\.com/i.test(url)) rede = 'instagram';
    else if (/linkedin\.com/i.test(url)) rede = 'linkedin';
    redes.push({ rede, url });
  });
  return redes;
}

/** Sidebar "Contato" presente em /sac e /trabalhe-conosco (telefone + endereço). */
function parseContatoSidebar($) {
  const out = { telefone: null, endereco: null };
  $('.global-block').each((_, block) => {
    const titulo = clean($('.global-title', block).text());
    if (titulo.toLowerCase() !== 'contato') return;
    $('.global-item-list p', block).each((_, p) => {
      const t = clean($(p).text());
      if (!t) return;
      if (/^\+?[\d\s()\-.]{8,}$/.test(t)) out.telefone = t;
      else out.endereco = t;
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Formulários (SAC / Trabalhe Conosco)
// ---------------------------------------------------------------------------
function parseForm($, formEl) {
  const campos = [];
  $(formEl)
    .find('input, textarea, select')
    .each((_, el) => {
      const $el = $(el);
      const tag = el.tagName.toLowerCase();
      const typeAttr = ($el.attr('type') || '').toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'button'].includes(typeAttr)) return;

      const type = tag === 'input' ? typeAttr || 'text' : tag;
      const name = $el.attr('name') || null;
      const required = $el.attr('required') !== undefined;

      // label: placeholder; para <select>/file, procura texto adjacente
      let label = clean($el.attr('placeholder'));
      if (!label && type === 'file') {
        const prev = clean($el.prev('div').text());
        if (prev) label = prev;
      }
      if (!label && type === 'select') {
        const first = clean($el.find('option').first().text());
        if (first) label = first;
      }

      const campo = { name, label: label || null, type, required };

      if (type === 'select') {
        campo.opcoes = $el
          .find('option')
          .map((_, opt) => ({ label: clean($(opt).text()), value: $(opt).attr('value') ?? '' }))
          .get();
      }
      if (type === 'file') {
        campo.accept = $el.attr('accept') || null;
        const nota = clean($el.next('div').text());
        if (nota) campo.nota = nota;
      }
      campos.push(campo);
    });

  const botaoEnviar =
    $(formEl).find('input[type="submit"]').attr('value') ||
    clean($(formEl).find('button[type="submit"]').text()) ||
    null;

  return { titulo: clean($(formEl).find('.global-title, h2').first().text()) || null, campos, botaoEnviar };
}

/** Texto introdutório: parágrafos dentro do conteúdo principal, fora do formulário. */
function parseIntroText($) {
  const parts = [];
  $('._70 .global-rich-text')
    .children()
    .each((_, el) => {
      if ($(el).is('.form-wrapper') || $(el).find('form').length) return;
      const t = clean($(el).text());
      if (t) parts.push(t);
    });
  return parts.length ? parts.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Página: Linha do tempo
// ---------------------------------------------------------------------------
function parseTimeline($) {
  const eventos = [];
  $('.timeline-item').each((_, item) => {
    const $item = $(item);
    const ano = clean($item.find('.timeline-year').first().text());
    const texto = clean($item.find('.timeline-text').first().text());

    // Imagem: <img class="timeline-img"> ou slider de imagens (.global-slide img)
    let imagem = $item.find('img.timeline-img').first().attr('src') || null;
    const sliderImgs = $item
      .find('.global-slide img')
      .map((_, img) => absUrl($(img).attr('src')))
      .get()
      .filter(Boolean);
    if (!imagem && sliderImgs.length) imagem = sliderImgs[0];

    const evento = {
      ano,
      // O HTML do site não possui título por evento — mantido como null por fidelidade ao copy.
      titulo: null,
      texto,
      imagem: absUrl(imagem),
    };
    if (sliderImgs.length > 1) evento.imagens = sliderImgs;
    eventos.push(evento);
  });

  eventos.sort((a, b) => Number(a.ano) - Number(b.ano));
  return eventos;
}

// ---------------------------------------------------------------------------
// Página: Home
// ---------------------------------------------------------------------------
function parseHome($) {
  // Hero (slider principal)
  const slides = $('.home-slider .home-slide')
    .map((_, slide) => {
      const $s = $(slide);
      const titulo = clean($s.find('.home-slider-title').text());
      const url = $s.find('a.home-slider-title-wrapper').attr('href') || null;
      const imagem = absUrl($s.find('.home-slide-img img').attr('src'));
      // O slide inteiro é um link (não há botão com texto próprio); CTA = destino do link.
      return { titulo, subtitulo: null, cta: { texto: null, url: absUrl(url) }, imagem };
    })
    .get();

  // Bloco destaque "Desde 1957 / No que acreditamos" (missão/valores da home)
  const $feat = $('.home-featured');
  const missaoValores = {
    titulo: clean($feat.find('.home-featured-title').text()),
    subtitulo: clean($feat.find('.home-featured-block-title').text()),
    texto: clean($feat.find('.home-featured-50 p').text()),
    cta: {
      texto: clean($feat.find('.home-featured-button').text()) || null,
      url: absUrl($feat.find('.home-featured-button').attr('href')),
    },
  };

  // Abas de produtos (Cosméticos / Medicamentos / Alimentos)
  const tabNames = $('.tabs-menu .tab-link')
    .map((_, el) => clean($(el).text()))
    .get();
  const abasProdutos = $('.tabs-content [data-w-tab]')
    .map((i, pane) => {
      const produtos = $(pane)
        .find('.slide-wrapper')
        .map((_, s) => ({
          titulo: clean($('.slide-title', s).text()),
          texto: clean($('.slide-content p', s).text()),
          cta: {
            texto: clean($('a.slide-button', s).text()) || null,
            url: absUrl($('a.slide-button', s).attr('href')),
          },
          imagem: absUrl($('.slide-image img', s).attr('src')),
        }))
        .get();
      return { titulo: tabNames[i] || clean($(pane).attr('data-w-tab')), produtos };
    })
    .get();

  // Slider de posts do blog (conteúdo dinâmico — capturado como referência de layout/copy)
  const blogRecentes = $('.slider-blog .slide-blog-item')
    .map((_, item) => {
      const $i = $(item);
      return {
        data: clean($i.find('strong').first().text()),
        titulo: clean($i.find('.slide-blog-title').text()),
        url: absUrl($i.find('.slide-blog-title').attr('href')),
        resumo: clean($i.find('p').first().text()),
        categoria: clean($i.find('a.post-link').text()) || null,
      };
    })
    .get();

  return {
    hero: { slides },
    missaoValores,
    // Blocos na ordem em que aparecem na página (após o hero e o destaque)
    blocos: [
      { tipo: 'destaque', ...missaoValores },
      { tipo: 'abasProdutos', abas: abasProdutos },
      { tipo: 'blogRecentes', observacao: 'Conteúdo dinâmico (últimos posts do blog)', posts: blogRecentes },
    ],
  };
}

// ---------------------------------------------------------------------------
// Página: Quem Somos
// ---------------------------------------------------------------------------
function parseQuemSomos($) {
  const blocos = [];
  let atual = null;

  $('._70 .global-rich-text')
    .contents()
    .each((_, node) => {
      const $n = $(node);

      if (node.type === 'text') {
        const t = clean(node.data);
        if (t) {
          blocos.push({ tipo: 'texto', titulo: null, texto: t });
          atual = null;
        }
        return;
      }
      if (node.type !== 'tag') return;

      const tag = node.tagName.toLowerCase();

      if (/^h[1-6]$/.test(tag)) {
        atual = { tipo: 'texto', titulo: clean($n.text()), texto: '' };
        blocos.push(atual);
        return;
      }

      if (tag === 'p') {
        const t = clean($n.text());
        if (!t) return;
        // "Endereço:" (strong isolado terminando em dois-pontos) inicia novo bloco titulado
        if ($n.children('strong').length && /:$/.test(t) && t.length < 60) {
          atual = { tipo: 'texto', titulo: t.replace(/:$/, ''), texto: '' };
          blocos.push(atual);
          return;
        }
        if (atual && !atual.texto) atual.texto = t;
        else {
          blocos.push({ tipo: 'texto', titulo: null, texto: t });
          atual = null;
        }
        return;
      }

      // Galeria de imagens (slider)
      if ($n.hasClass('global-slider') || $n.find('.global-slide').length) {
        const imagens = $n
          .find('.global-slide')
          .map((_, s) => ({
            url: absUrl($('img', s).attr('src')),
            legenda: clean($('.global-subtitle', s).text()) || clean($('img', s).attr('alt')) || null,
          }))
          .get();
        if (imagens.length) blocos.push({ tipo: 'galeria', imagens });
        atual = null;
      }
    });

  return {
    titulo: clean($('.header-title').text()) || 'Quem Somos',
    blocos: blocos.filter((b) => b.tipo !== 'texto' || b.texto || b.titulo),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Raspando ${BASE_URL} ...`);

  const $home = await fetchHTML(PATHS.home);
  const $quemSomos = await fetchHTML(PATHS.quemSomos);
  const $timeline = await fetchHTML(PATHS.linhaDoTempo);
  const $sac = await fetchHTML(PATHS.sac);
  const $trabalhe = await fetchHTML(PATHS.trabalheConosco);

  // --- Linha do tempo -------------------------------------------------------
  const eventos = parseTimeline($timeline);

  // --- SAC / Trabalhe Conosco ------------------------------------------------
  const sacForm = parseForm($sac, $sac('form').first());
  const sac = {
    titulo: clean($sac('.header-title').text()) || 'SAC',
    textoIntro: parseIntroText($sac), // a página atual não tem texto introdutório além do form
    formulario: sacForm,
  };

  const trabForm = parseForm($trabalhe, $trabalhe('form').first());
  const trabalheConosco = {
    titulo: clean($trabalhe('.header-title').text()) || 'Trabalhe Conosco',
    textoIntro: parseIntroText($trabalhe),
    formulario: trabForm,
    uploadCurriculo: trabForm.campos.some((c) => c.type === 'file'),
  };

  // --- Contato (sidebar do SAC + redes sociais + e-mails do select) ---------
  const sidebar = parseContatoSidebar($sac);
  const emailsDepartamentos = (sacForm.campos.find((c) => c.type === 'select')?.opcoes || [])
    .filter((o) => /@/.test(o.value))
    .map((o) => ({ departamento: o.label, email: o.value }));
  const emailGeral =
    emailsDepartamentos.find((e) => /selecione/i.test(e.departamento))?.email ||
    emailsDepartamentos[0]?.email ||
    null;

  const contato = {
    telefone: sidebar.telefone,
    email: emailGeral, // e-mail padrão do formulário SAC (não há e-mail exibido textualmente no site)
    emailsDepartamentos: emailsDepartamentos.filter((e) => !/selecione/i.test(e.departamento)),
    endereco: sidebar.endereco,
    redesSociais: parseSocial($sac).length ? parseSocial($sac) : parseSocial($home),
  };

  // --- Loja ------------------------------------------------------------------
  const lojaUrl = parseLojaUrl($home) || parseLojaUrl($sac);

  const institucional = {
    fonte: BASE_URL,
    extraidoEm: new Date().toISOString(),
    home: parseHome($home),
    quemSomos: parseQuemSomos($quemSomos),
    sac,
    trabalheConosco,
    contato,
    lojaUrl,
  };

  // --- Escrita ----------------------------------------------------------------
  await mkdir(path.dirname(OUT_TIMELINE), { recursive: true });
  await mkdir(path.dirname(OUT_INSTITUCIONAL), { recursive: true });
  await writeFile(OUT_TIMELINE, JSON.stringify(eventos, null, 2) + '\n', 'utf8');
  await writeFile(OUT_INSTITUCIONAL, JSON.stringify(institucional, null, 2) + '\n', 'utf8');
  console.log(`\nEscrito: ${OUT_TIMELINE}`);
  console.log(`Escrito: ${OUT_INSTITUCIONAL}`);

  // --- Validação ---------------------------------------------------------------
  const problemas = [];
  const tl = JSON.parse(await readFile(OUT_TIMELINE, 'utf8'));
  const inst = JSON.parse(await readFile(OUT_INSTITUCIONAL, 'utf8'));

  if (!Array.isArray(tl) || tl.length === 0) problemas.push('timeline vazia');
  tl.forEach((ev, i) => {
    if (!/^\d{4}$/.test(ev.ano)) problemas.push(`timeline[${i}]: ano inválido "${ev.ano}"`);
    if (!ev.texto) problemas.push(`timeline[${i}] (${ev.ano}): texto vazio`);
    if (!ev.imagem) problemas.push(`timeline[${i}] (${ev.ano}): imagem vazia`);
  });

  const req = (cond, msg) => { if (!cond) problemas.push(msg); };
  req(inst.home.hero.slides.length > 0, 'home.hero sem slides');
  inst.home.hero.slides.forEach((s, i) => req(s.titulo && s.cta.url, `home.hero.slides[${i}] incompleto`));
  req(inst.home.missaoValores.titulo && inst.home.missaoValores.texto, 'home.missaoValores incompleto');
  req(inst.home.blocos.length >= 2, 'home.blocos insuficientes');
  req(
    inst.home.blocos.find((b) => b.tipo === 'abasProdutos')?.abas.every((a) => a.titulo && a.produtos.length),
    'home abasProdutos incompletas'
  );
  req(inst.quemSomos.blocos.length >= 4, 'quemSomos com poucos blocos');
  req(
    inst.quemSomos.blocos.some((b) => b.titulo === 'Missão' && b.texto) &&
      inst.quemSomos.blocos.some((b) => b.titulo === 'Visão' && b.texto),
    'quemSomos sem Missão/Visão'
  );
  req(inst.sac.formulario.campos.length >= 6, 'sac.formulario com poucos campos');
  inst.sac.formulario.campos.forEach((c, i) =>
    req(c.name && c.type && (c.label || c.type === 'file'), `sac campo[${i}] sem name/label/type`)
  );
  req(inst.trabalheConosco.formulario.campos.length >= 6, 'trabalheConosco.formulario com poucos campos');
  req(inst.trabalheConosco.uploadCurriculo === true, 'trabalheConosco sem upload de currículo');
  req(inst.contato.telefone, 'contato.telefone vazio');
  req(inst.contato.endereco, 'contato.endereco vazio');
  req(inst.contato.email, 'contato.email vazio');
  req(inst.contato.redesSociais.length >= 1, 'contato sem redes sociais');
  req(typeof inst.lojaUrl === 'string' && inst.lojaUrl.startsWith('http'), 'lojaUrl ausente');

  console.log(`\nResumo: ${tl.length} eventos na timeline; ` +
    `${inst.sac.formulario.campos.length} campos no SAC; ` +
    `${inst.trabalheConosco.formulario.campos.length} campos no Trabalhe Conosco; ` +
    `${inst.home.hero.slides.length} slides no hero.`);

  if (problemas.length) {
    console.error('\nVALIDAÇÃO FALHOU:');
    problemas.forEach((p) => console.error(`  ✘ ${p}`));
    process.exit(1);
  }
  console.log('Validação OK: JSONs parseiam e nenhum campo essencial ficou vazio.');
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
