interface BreadcrumbItem {
  name: string;
  url: string;
}

export function generateBreadcrumbJsonLd(items: BreadcrumbItem[], siteUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${siteUrl}${item.url}`,
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
    name: `${seriesTitle} - kolejność książek`,
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
    url: `${siteUrl}/${slug}`,
  };
}
