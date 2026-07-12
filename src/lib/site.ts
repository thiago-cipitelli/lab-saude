import institucional from '../data/institucional.json';

export const SITE = {
  name: 'Laboratório Saúde',
  description:
    'O Laboratório Saúde está no ramo farmacêutico há mais de 60 anos e é reconhecido por produtos que moram no coração dos gaúchos — do bebê aos avós, com qualidade e carinho desde 1957.',
  foundedYear: 1957,
  lojaUrl: institucional.lojaUrl as string,
  contato: institucional.contato as {
    telefone: string;
    email: string;
    emailsDepartamentos: Array<{ departamento: string; email: string }>;
    endereco?: string;
    redes?: Record<string, string>;
  },
  endereco: 'Rua Voluntários da Pátria, 3969 — Navegantes, Porto Alegre/RS — CEP 90230-020',
  redes: {
    facebook: 'http://fb.com/laboratoriosaudeltda/',
    youtube: 'https://www.youtube.com/channel/UCzLADS2YBa10QkHYANADXyA',
  },
};

export const NAV = [
  { label: 'Produtos', href: '/produtos/' },
  { label: 'Quem Somos', href: '/quem-somos/' },
  { label: 'Nossa História', href: '/linha-do-tempo/' },
  { label: 'Blog', href: '/blog/' },
  { label: 'SAC', href: '/sac/' },
  { label: 'Trabalhe Conosco', href: '/trabalhe-conosco/' },
] as const;

export const CATEGORIAS = [
  { slug: 'cosmeticos', nome: 'Cosméticos' },
  { slug: 'medicamentos', nome: 'Medicamentos' },
  { slug: 'alimentos', nome: 'Alimentos' },
] as const;

export function categoriaSlug(nome: string): string {
  return (
    CATEGORIAS.find((c) => c.nome === nome)?.slug ??
    nome
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
  );
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(date);
}
