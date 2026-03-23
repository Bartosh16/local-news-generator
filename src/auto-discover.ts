/**
 * Auto-discovery portali dla miast bez przypisanych portali.
 *
 * Używa Brave Search API do wyszukania "[miasto] wiadomości",
 * filtruje wyniki (odrzuca ogólnopolskie i social media),
 * crawluje i auto-dobiera selektor CSS za pomocą crawler-selector.
 *
 * Uruchomienie: npx tsx src/auto-discover.ts [--from 95] [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { CrawlerSelectorService } from './crawler-selector/crawler-selector.service.js';
import { FetchHtmlFetcher } from './crawler-selector/adapters/fetch-html-fetcher.js';
import { DomAnalyzer } from './crawler-selector/domain/dom-analyzer.js';
import { loadAllPortals, getUniqueCities, saveCustomPortal } from './scraping/csv-parser.js';

dotenv.config();

// === Konfiguracja ===

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const CSV_PATH = path.resolve(process.cwd(), 'portale-newsowe.csv');
const MAX_PORTALS_PER_CITY = 5;
const CRAWL_TIMEOUT_MS = 12000;

// Portale ogólnopolskie i social media do odfiltrowania
const BLOCKED_DOMAINS = new Set([
    // Ogólnopolskie
    'tvn24.pl', 'tvp.pl', 'tvp.info', 'polsatnews.pl', 'polsat.pl',
    'onet.pl', 'wp.pl', 'wiadomosci.wp.pl', 'interia.pl', 'fakt.pl',
    'o2.pl', 'gazeta.pl', 'wyborcza.pl', 'natemat.pl', 'noizz.pl',
    'pudelek.pl', 'pomponik.pl', 'plotek.pl', 'se.pl', 'niezalezna.pl',
    'money.pl', 'bankier.pl', 'businessinsider.com.pl', 'forbes.pl',
    'rmf24.pl', 'rmffm.pl', 'polskieradio.pl', 'polskieradio24.pl',
    'tokfm.pl', 'radio.net', 'radiozet.pl',
    'dziennik.pl', 'rp.pl', 'rzeczpospolita.pl', 'newsweek.pl',
    'polityka.pl', 'tygodnikpowszechny.pl', 'wprost.pl',
    'sport.pl', 'sportowefakty.wp.pl', 'meczyki.pl', 'transfermarkt.pl',
    'auto-swiat.pl', 'autokult.pl',
    'wikipedia.org', 'wikimedia.org',
    'gov.pl', 'bip.gov.pl',
    'olx.pl', 'allegro.pl', 'ceneo.pl', 'pracuj.pl',
    'booking.com', 'tripadvisor.com', 'tripadvisor.pl',
    'yelp.com', 'google.com', 'google.pl', 'maps.google.com',
    // Social media
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'reddit.com', 'pinterest.com', 'tiktok.com', 'youtube.com',
    'linkedin.com', 'threads.net', 'tumblr.com',
    // Agregatory
    'news.google.com', 'msn.com', 'yahoo.com',
]);

// === Brave Search ===

interface BraveSearchResult {
    url: string;
    title: string;
    domain: string;
}

async function braveSearch(query: string): Promise<BraveSearchResult[]> {
    if (!BRAVE_API_KEY) throw new Error('Brak BRAVE_SEARCH_API_KEY w .env');

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&search_lang=pl&country=pl`;

    const res = await fetch(url, {
        headers: { 'X-Subscription-Token': BRAVE_API_KEY, 'Accept': 'application/json' },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Brave API ${res.status}: ${body}`);
    }

    const data = await res.json() as any;
    const results: BraveSearchResult[] = [];

    for (const r of (data.web?.results || [])) {
        try {
            const domain = new URL(r.url).hostname.replace(/^www\./, '');
            results.push({ url: r.url, title: r.title || '', domain });
        } catch { /* skip malformed URLs */ }
    }

    return results;
}

// === Filtrowanie ===

function isBlockedDomain(domain: string): boolean {
    // Sprawdź dokładne dopasowanie i subdomenę
    for (const blocked of BLOCKED_DOMAINS) {
        if (domain === blocked || domain.endsWith('.' + blocked)) return true;
    }
    return false;
}

function filterResults(results: BraveSearchResult[]): BraveSearchResult[] {
    const seen = new Set<string>();
    return results.filter(r => {
        if (isBlockedDomain(r.domain)) return false;
        if (seen.has(r.domain)) return false; // 1 URL per domena
        seen.add(r.domain);
        return true;
    });
}

// === Główna logika ===

async function discoverPortalsForCity(
    city: string,
    crawlerService: CrawlerSelectorService
): Promise<{ url: string; selector: string; newsCount: number }[]> {
    const query = `${city} wiadomości`;
    console.log(`  🔍 Brave Search: "${query}"`);

    const results = braveSearch(query).catch(err => {
        console.error(`  ❌ Brave Search error: ${err.message}`);
        return [] as BraveSearchResult[];
    });

    const filtered = filterResults(await results);
    console.log(`  📋 ${filtered.length} wyników po filtracji (z ${(await results).length} raw)`);

    const portals: { url: string; selector: string; newsCount: number }[] = [];

    for (const result of filtered.slice(0, 10)) {
        if (portals.length >= MAX_PORTALS_PER_CITY) break;

        try {
            console.log(`    🌐 Crawling: ${result.domain}...`);
            const selectorResult = await Promise.race([
                crawlerService.extractNewsList({
                    url: result.url,
                    timeoutMs: CRAWL_TIMEOUT_MS,
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Global timeout 20s')), 20000)),
            ]);

            if (selectorResult.newsUrls.length >= 2) {
                portals.push({
                    url: result.url,
                    selector: selectorResult.cssSelector,
                    newsCount: selectorResult.newsUrls.length,
                });
                console.log(`    ✅ ${result.domain} → selector: "${selectorResult.cssSelector}" (${selectorResult.newsUrls.length} artykułów)`);
            } else {
                console.log(`    ⚠️  ${result.domain} → za mało artykułów (${selectorResult.newsUrls.length})`);
            }
        } catch (err: any) {
            console.log(`    ❌ ${result.domain} → ${err.message || 'nie crawlable'}`);
        }
    }

    return portals;
}

async function main() {
    const args = process.argv.slice(2);
    const fromIndex = args.includes('--from') ? parseInt(args[args.indexOf('--from') + 1]) : 1;
    const dryRun = args.includes('--dry-run');

    if (!BRAVE_API_KEY) {
        console.error('❌ Brak BRAVE_SEARCH_API_KEY w .env. Wpisz klucz i uruchom ponownie.');
        process.exit(1);
    }

    console.log(`\n🚀 Auto-discovery portali`);
    console.log(`   Od miasta #${fromIndex}`);
    if (dryRun) console.log('   ⚠️  DRY RUN — nic nie zapisuję');
    console.log('');

    // Załaduj aktualne miasta i portale
    const allPortals = loadAllPortals(CSV_PATH);
    const cities = getUniqueCities(allPortals);

    console.log(`📊 Znaleziono ${cities.length} miast w bazie\n`);

    // Inicjalizacja crawler-selector
    const htmlFetcher = new FetchHtmlFetcher();
    const domAnalyzer = new DomAnalyzer();
    const crawlerService = new CrawlerSelectorService(htmlFetcher, domAnalyzer);

    let processed = 0;
    let added = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = fromIndex - 1; i < cities.length; i++) {
        const city = cities[i];
        const cityPortals = allPortals.filter(p => p.city.toLowerCase() === city.toLowerCase());
        const num = i + 1;

        const needed = MAX_PORTALS_PER_CITY - cityPortals.length;
        if (needed <= 0) {
            console.log(`[${num}/${cities.length}] ${city} — ma ${cityPortals.length} portali (max ${MAX_PORTALS_PER_CITY}), pomijam`);
            skipped++;
            continue;
        }
        console.log(`[${num}/${cities.length}] ${city} — ma ${cityPortals.length} portali, szukam ${needed} więcej...`);

        try {
            const discovered = await discoverPortalsForCity(city, crawlerService);

            if (discovered.length === 0) {
                console.log(`  ⚠️  Brak wyników dla ${city}\n`);
                failed++;
                continue;
            }

            // Filtruj portale które już są przypisane
            const existingUrls = new Set(cityPortals.map(p => {
                try { return new URL(p.newsUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
            }));

            const newPortals = discovered.filter(d => {
                try {
                    const domain = new URL(d.url).hostname.replace(/^www\./, '');
                    return !existingUrls.has(domain);
                } catch { return false; }
            });

            for (const portal of newPortals.slice(0, needed)) {
                if (!dryRun) {
                    saveCustomPortal({
                        city,
                        portalName: new URL(portal.url).hostname.replace(/^www\./, ''),
                        newsUrl: portal.url,
                        cssSelector: portal.selector,
                        status: 'Działa',
                        isCustom: true,
                    });
                }
                added++;
                console.log(`  💾 Zapisano: ${new URL(portal.url).hostname} (${portal.newsCount} artykułów)`);
            }

            processed++;
            console.log('');

            // Throttle — 1 sekunda między miastami żeby nie przekroczyć limitu Brave
            await new Promise(r => setTimeout(r, 1000));

        } catch (err: any) {
            console.error(`  ❌ Błąd: ${err.message}\n`);
            failed++;
        }
    }

    console.log('\n════════════════════════════════════════');
    console.log(`✅ Gotowe!`);
    console.log(`   Przetworzono: ${processed} miast`);
    console.log(`   Dodano: ${added} portali`);
    console.log(`   Pominięto (ma 3+): ${skipped}`);
    console.log(`   Błędy: ${failed}`);
    console.log('════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
