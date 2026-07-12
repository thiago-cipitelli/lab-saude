# Laboratório Saúde — site em Astro + WordPress headless

Redesign moderno de [saude.ind.br](https://www.saude.ind.br) construído em **Astro 7** com
o WordPress atual do cliente atuando como CMS headless **somente para o blog**.
Demo de venda: deploy estático na Vercel, sem custo e sem tocar no WordPress do cliente.

## Modelo de conteúdo (híbrido)

| Conteúdo | Fonte | Atualização |
|---|---|---|
| Blog (24 posts) | WP REST API (`/wp-json/wp/v2/posts`) em **build time** | A cada build — o cliente continua publicando no painel WP |
| Páginas institucionais | Extraídas do site atual, versionadas em `src/data/institucional.json` | Manual (raras) |
| Produtos (16) | Extraídos do site atual → `src/content/produtos/*.md` | Manual (raras) |
| Linha do tempo (13 eventos) | `src/content/timeline/eventos.json` | Manual |
| Imagens (117 mídias + tema) | Baixadas para `src/assets/` (`media-manifest.json` mapeia origem) | — |

O motivo do híbrido: a REST API do cliente só expõe posts — páginas usam ACF fechado e o
CPT `produtos` não está na API. O scraping é one-time, feito pelos scripts abaixo.

## Comandos

```bash
npm install
npm run dev        # desenvolvimento
npm run build      # gera dist/ (busca o blog na API do WP — precisa de rede)
npm run preview    # serve o build local
```

Se a API do WordPress estiver fora do ar, **o build falha de propósito** (melhor do que
publicar o blog vazio).

## Scripts de extração (re-executáveis, parametrizáveis para outros clientes)

```bash
node scripts/download-media.mjs       # mídias da API + crawl de páginas + assets do tema
node scripts/scrape-produtos.mjs      # produtos → content collections
node scripts/scrape-institucional.mjs # copy institucional + linha do tempo
```

Todos são idempotentes (pulam o que já existe) e têm a URL base no topo do arquivo.

## Design

- **Direção**: herança de botica, execução editorial contemporânea — papel-creme com grão,
  vermelho da marca como âncora, selo giratório "Desde 1957".
- **Tipografia**: Fraunces (display) + **MundoSans**, a fonte proprietária da marca,
  recuperada do tema antigo (`src/assets/fonts/`, pesos Light/Med/Bold).
- **Cores**: logo usa o vermelho exato `#e70032`; texto/superfícies usam `#dc002f`
  (tom mais próximo que cumpre WCAG AA — ver `src/styles/global.css`).
- Tokens no bloco `@theme` de `src/styles/global.css` (Tailwind v4).

## SEO

- URLs **idênticas** às do WordPress (`/produtos/<slug>/`, `/blog/<slug>/`,
  `/categorias/<slug>/`) — ranking preservado no go-live.
- Sitemap em `/sitemap-index.xml` + redirects dos sitemaps Yoast no `vercel.json`.
- JSON-LD: Organization (todas), Product (produtos), BlogPosting (posts).
- **Demo**: `vercel.json` envia `X-Robots-Tag: noindex` para não competir com o site
  atual no Google. **REMOVER no go-live.**

## Qualidade (medido em build local com gzip)

Lighthouse: Performance 88–94 · Acessibilidade 100 · Best Practices 100 · SEO 100.
1691 links internos verificados, zero quebrados. 51 rotas estáticas.

## Deploy da demo

```bash
npx vercel deploy   # ou conectar o repositório no dashboard da Vercel
```

Build command `astro build`, output `dist/`, sem adapter.

## Checklist pós-aprovação (go-live)

1. **DNS**: apontar `www.saude.ind.br` para a Vercel (o WP do cliente passa a responder
   só como backend, ex. em `wp.saude.ind.br` ou pelo IP atual).
2. **Remover o `X-Robots-Tag: noindex`** do `vercel.json`.
3. **Rebuild automático do blog**: criar um Deploy Hook na Vercel e instalar no WP um
   webhook em `publish_post` (plugin "WP Webhooks" ou mu-plugin de ~10 linhas) chamando o
   hook — post publicado → site reconstruído.
4. **Formulários reais**: SAC e Trabalhe Conosco estão visual-only (comentário
   `INTEGRAÇÃO REAL PÓS-APROVAÇÃO` marca o ponto). Opções: Web3Forms/Formspree (sem
   backend) ou Vercel Function + Resend; Trabalhe Conosco tem upload de currículo
   (exige function + storage ou provedor com suporte a anexo).
5. **Imagens dos corpos de post**: hoje são hotlink do WP (ok enquanto o WP viver).
   Baixá-las e reescrever URLs se o WP for desativado um dia.
6. E-mails por departamento do select do SAC estão em `src/data/institucional.json`
   (`contato.emailsDepartamentos`) para roteamento do form real.
