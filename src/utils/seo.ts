// JSON-LD structured data generators shared by all pages.

interface BreadcrumbItem {
  name: string;
  url: string;
}

// Canonical URLs end with a trailing slash (Astro directory format),
// so structured data URLs are normalized to match them exactly.
export function buildPageUrl(siteUrl: string, path: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === '/') return `${base}/`;
  return `${base}${normalized}${normalized.endsWith('/') ? '' : '/'}`;
}

export function generateBreadcrumbJsonLd(items: BreadcrumbItem[], siteUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: buildPageUrl(siteUrl, item.url),
    })),
  };
}

interface FaqItem {
  question: string;
  answer: string;
}

export function generateFaqJsonLd(faqs: FaqItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

interface BookEntry {
  order: number;
  title: string;
  titleOriginal?: string;
  yearOriginal: number;
  yearPolish?: number;
  type?: string;
}

export function generateItemListJsonLd(
  seriesTitle: string,
  books: BookEntry[],
  siteUrl: string,
  slug: string
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${seriesTitle} — kolejność czytania`,
    numberOfItems: books.length,
    itemListElement: books.map((book) => ({
      '@type': 'ListItem',
      position: book.order,
      item: {
        '@type': 'Book',
        name: book.title,
        ...(book.titleOriginal && { alternateName: book.titleOriginal }),
        datePublished: String(book.yearOriginal),
      },
    })),
    url: buildPageUrl(siteUrl, `/${slug}`),
  };
}

export function generateBookSeriesJsonLd(
  seriesTitle: string,
  author: string,
  siteUrl: string,
  slug: string,
  bookCount: number
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BookSeries',
    name: seriesTitle,
    author: { '@type': 'Person', name: author },
    numberOfItems: bookCount,
    url: buildPageUrl(siteUrl, `/${slug}`),
  };
}

export function generateWebsiteJsonLd(siteUrl: string, siteName: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: buildPageUrl(siteUrl, '/'),
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${buildPageUrl(siteUrl, '/szukaj')}?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

interface CollectionItem {
  name: string;
  path: string;
}

export function generateCollectionPageJsonLd(
  name: string,
  description: string,
  siteUrl: string,
  path: string,
  items: CollectionItem[]
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url: buildPageUrl(siteUrl, path),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.map((item, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: item.name,
        url: buildPageUrl(siteUrl, item.path),
      })),
    },
  };
}
