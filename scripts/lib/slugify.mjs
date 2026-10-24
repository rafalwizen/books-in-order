// Slug rules matching the conventions of the existing src/content/series files:
// - lowercase, Polish (and common Latin) diacritics transliterated to ASCII
// - periods and apostrophes deleted before hyphenation ("J.K." -> "jk")
// - any other non-alphanumeric run collapsed into a single hyphen
//
// Regression reference (must hold for all existing files):
//   "J.K. Rowling" -> jk-rowling, "J.R.R. Tolkien" -> jrr-tolkien,
//   "Ursula K. Le Guin" -> ursula-k-le-guin, "George R.R. Martin" -> george-rr-martin

const TRANSLIT = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  ä: 'a', ö: 'o', ü: 'u', ß: 'ss',
  á: 'a', à: 'a', â: 'a', é: 'e', è: 'e', ê: 'e', í: 'i', ì: 'i',
  ú: 'u', ù: 'u', û: 'u', ñ: 'n', ç: 'c', å: 'a', ø: 'o', æ: 'ae', œ: 'oe',
  ð: 'd', þ: 'th',
};

export function transliterate(text) {
  return [...text]
    .map((ch) => {
      const lower = ch.toLowerCase();
      return TRANSLIT[lower] ?? ch;
    })
    .join('');
}

export function slugifyAuthor(name) {
  return transliterate(name.toLowerCase())
    .replace(/[.'’`´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Used for advisory checks only — series filenames follow the best-known
// Polish name (e.g. "gra-o-tron"), not necessarily the literal title.
export function slugifyTitle(title) {
  return slugifyAuthor(title);
}
