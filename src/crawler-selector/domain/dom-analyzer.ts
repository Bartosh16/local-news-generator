import * as cheerio from 'cheerio';
import { SelectorExtractionFailedError } from './errors';

// Wzorce ścieżek URL typowe dla artykułów newsowych
const ARTICLE_PATH_PATTERNS = [
  '/artykul/', '/artykuly/', '/news/', '/wiadomosci/', '/wiadomosc/',
  '/aktualnosc/', '/aktualnosci/', '/post/', '/publikacje/', '/informacje/',
];

export class DomAnalyzer {
  /**
   * Analizuje HTML, usuwa nieistotne tagi, znajduje głowny blok newsów
   * i generuje unikalny CSS selektor oraz listę linków.
   */
  analyze(html: string, baseUrl: string): { selector: string; urls: string[] } {
    // Załaduj HTML dwukrotnie: pełny (do fallbacku URL) i oczyszczony (do heurystyki)
    const $full = cheerio.load(html);
    const $ = cheerio.load(html);

    // 1. Usunięcie "śmieci" zgodnie z zaleceniami
    $('header, footer, nav, aside, .sidebar, style, script, noscript, svg, form, iframe').remove();
    // Odfiltrowywujemy również elementy, które często oznaczają menu, reklamy, i poboczne widgety
    $('.menu, .navigation, .ads, .advertisement, .widget, .popup, #cookie-banner').remove();

    // 2. Ograniczamy wyszukiwanie do tagu main, article, section lub po prostu body (z filtrowaniem)
    const context = $('main, #main, .main, #content, .content, article, section').length > 0
      ? $('main, #main, .main, #content, .content, article, section')
      : $('body');

    const links = context.find('a[href]');

    // Zliczanie powtarzających się struktur klas rodziców
    const selectorCounts = new Map<string, Set<string>>();

    links.each((_, el) => {
      const href = $(el).attr('href');
      // Filtrowanie dodatkowych śmieci typu tagi
      if (!href || this.isIgnoredLink(href, baseUrl) || href.includes('/tag/') || href.includes('/tagi/') || href.includes('/author/')) {
        return;
      }

      const fullUrl = this.resolveUrl(href, baseUrl);

      // Heurystyka: szukamy struktury rodziców (do 3 poziomów w górę)
      const parentSelector = this.generateParentSelector($(el), $);
      if (parentSelector) {
        if (!selectorCounts.has(parentSelector)) {
          selectorCounts.set(parentSelector, new Set());
        }
        selectorCounts.get(parentSelector)!.add(fullUrl);
      }
    });

    // 3. Wybór selektora o największej gęstości linków (artykułów)
    let bestSelector = '';
    let maxLinks = 0;
    let selectedUrls: string[] = [];

    for (const [selector, urlSet] of selectorCounts.entries()) {
      // Co najmniej 2 newsy żeby zakwalifikować selektor
      if (urlSet.size > maxLinks && urlSet.size >= 2) {
        maxLinks = urlSet.size;
        bestSelector = selector;
        selectedUrls = Array.from(urlSet);
      }
    }

    if (!bestSelector) {
      // Fallback: szukaj po wzorcach URL w pełnym HTML (przed usunięciem nawigacji)
      const articleUrls = new Set<string>();
      $full('a[href]').each((_, el) => {
        const href = $full(el).attr('href') || '';
        if (this.isIgnoredLink(href, baseUrl)) return;
        const fullUrl = this.resolveUrl(href, baseUrl);
        if (ARTICLE_PATH_PATTERNS.some(p => fullUrl.includes(p))) {
          articleUrls.add(fullUrl);
        }
      });

      if (articleUrls.size >= 2) {
        return { selector: 'a', urls: Array.from(articleUrls) };
      }

      throw new SelectorExtractionFailedError('Could not find a repetitive pattern of news links with a clear CSS selector.');
    }

    // Aby zachować dokładność do tagu okalającego link i samego linku, selektor będzie np. "div.news-item a"
    const refinedSelector = `${bestSelector} a`;

    return {
      selector: refinedSelector,
      urls: selectedUrls
    };
  }

  private isIgnoredLink(href: string, baseUrl: string): boolean {
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return true;
    }
    // Ignorowanie linków zewnętrznych (jeśli to portal, szukamy artykułów wewnętrznych)
    try {
      if (href.startsWith('http')) {
        const urlObj = new URL(href);
        const baseObj = new URL(baseUrl);
        // Sprawdzamy, czy link celuje w domenę portalu (lub jej subdomenę)
        if (!urlObj.hostname.includes(baseObj.hostname.replace(/^www\./, ''))) {
          return true;
        }
      }
    } catch {
      // ignore parse errors
    }
    return false;
  }

  private resolveUrl(href: string, baseUrl: string): string {
    if (href.startsWith('http')) {
      return href;
    }
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href; // Fallback
    }
  }

  /**
   * Generuje "podpis" CSS dla węzła rodzica
   */
  private generateParentSelector(element: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): string | null {
    // Sprawdzamy maksymalnie 3 poziomy w górę
    let current = element.parent();
    for (let i = 0; i < 3; i++) {
      if (!current || current.length === 0 || current.is('body') || current.is('html')) {
        break;
      }

      // Preferujemy rodziców z unikalnymi nazwami klas, jak 'article', 'news-card', 'post' itd.
      const className = current.attr('class');
      if (className) {
        // Ignoruj kontenery będące wyraźnie sidebarem, paginacją itp.
        if (className.includes('pagination') || className.includes('tags') || className.includes('social')) {
          return null;
        }

        // Bierzemy tylko pierwsze słowo kluczowe klasy (najczęściej właściwy komponent frontendowy)
        // Ignorujemy utility classes z Tailwinda (np. 'flex', 'p-4', 'mt-2')
        const mainClass = className.split(' ').find(c => c.length > 3 && !['flex', 'grid', 'text', 'font', 'bg', 'hover', 'block', 'w-', 'h-'].some(util => c.startsWith(`${util}-`)));
        
        if (mainClass) {
          return `${String(current.prop('tagName') ?? '').toLowerCase()}.${mainClass}`;
        }
      }

      // Jeśli elementem jest 'article' lub 'section', samo to może być dobrym selektorem ojcostwa
      const tagName = String(current.prop('tagName') ?? '').toLowerCase();
      if (tagName === 'article') {
        return 'article';
      }

      current = current.parent();
    }

    return null;
  }
}
