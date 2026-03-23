import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { PortalConfig, ScrapedLink, ExtractedArticle } from '../types.js';

const FETCH_TIMEOUT_MS = 15_000;
const PUPPETEER_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/**
 * Pobiera linki do artykułów z danego portalu na podstawie CSS selektora.
 * Fallback: fetch → Puppeteer+Stealth (dla 403/Cloudflare)
 */
export async function fetchLinks(portal: PortalConfig): Promise<ScrapedLink[]> {
    const html = await fetchHtmlWithFallback(portal.newsUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const links: ScrapedLink[] = [];
    const seenUrls = new Set<string>();

    $(portal.cssSelector).each((_, elem) => {
        const href = $(elem).attr('href');
        if (!href) return;

        const resolved = resolveUrl(href, portal.newsUrl);
        if (!resolved || seenUrls.has(resolved)) return;

        if (isJunkUrl(resolved)) return;

        seenUrls.add(resolved);
        links.push({
            url: resolved,
            title: $(elem).text().trim() || undefined,
            portal,
        });
    });

    return links.slice(0, 20);
}

/**
 * Pobiera i parsuje artykuł z URL.
 * Fallback: fetch → Puppeteer+Stealth (dla 403/Cloudflare)
 */
export async function extractArticle(link: ScrapedLink): Promise<ExtractedArticle> {
    const html = await fetchHtmlWithFallback(link.url);
    if (!html) {
        return makeInvalidArticle(link, 'Failed to fetch article HTML');
    }

    try {
        const dom = new JSDOM(html, { url: link.url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article) {
            return makeInvalidArticle(link, 'Readability could not parse article');
        }

        const wordCount = (article.textContent ?? '').split(/\s+/).filter(Boolean).length;
        const isValid = wordCount >= 50;

        return {
            url: link.url,
            title: article.title || link.title || '',
            rawText: article.textContent ?? '',
            rawHtml: article.content ?? '',
            extractedAt: new Date(),
            isValid,
            validationReason: isValid ? undefined : `Too short: ${wordCount} words (min 50)`,
            imageUrl: extractImageUrl(html, link.url),
        };
    } catch (err) {
        return makeInvalidArticle(link, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function extractImageUrl(html: string, baseUrl: string): string | undefined {
    const $ = cheerio.load(html);

    const candidates: (string | undefined)[] = [];
    candidates.push($('meta[property="og:image"]').attr('content'));

    $('article img').each((_, el) => {
        candidates.push($(el).attr('src'));
    });

    if (candidates.length <= 1) {
        $('img').each((_, el) => {
            candidates.push($(el).attr('src'));
        });
    }

    for (let url of candidates) {
        if (!url) continue;
        url = url.trim();
        if (!url) continue;

        if (url.startsWith('data:image')) continue;
        if (url.toLowerCase().endsWith('.svg')) continue;

        const resolved = resolveUrl(url, baseUrl);
        if (resolved) return resolved;
    }

    return undefined;
}

/**
 * Sprawdza czy URL jest crawlable (do walidacji nowych portali w dashboardzie).
/**
 * Sprawdza czy URL jest crawlable (do walidacji nowych portali w dashboardzie).
 * Zwraca informacje o statusie oraz sugerowane selektory CSS.
 */
export async function checkCrawlability(url: string): Promise<{
    ok: boolean;
    statusCode: number;
    method: string;
    sampleLinks: string[];
    suggestedSelectors: { selector: string; count: number }[];
}> {
    // Try plain fetch first
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: BROWSER_HEADERS,
        });
        clearTimeout(timer);

        if (resp.ok) {
            const html = await resp.text();
            const $ = cheerio.load(html);
            const { sampleLinks, suggestedSelectors } = analyzeSelectors($, url);
            return { ok: true, statusCode: resp.status, method: 'fetch', sampleLinks, suggestedSelectors };
        }

        if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
            // Try Puppeteer
            const puppeteerResult = await fetchWithPuppeteer(url);
            if (puppeteerResult) {
                const $ = cheerio.load(puppeteerResult);
                const { sampleLinks, suggestedSelectors } = analyzeSelectors($, url);
                return { ok: true, statusCode: 200, method: 'puppeteer-stealth', sampleLinks, suggestedSelectors };
            }
            return { ok: false, statusCode: resp.status, method: 'puppeteer-stealth-failed', sampleLinks: [], suggestedSelectors: [] };
        }

        return { ok: false, statusCode: resp.status, method: 'fetch', sampleLinks: [], suggestedSelectors: [] };
    } catch {
        // Network error, try Puppeteer
        const puppeteerResult = await fetchWithPuppeteer(url);
        if (puppeteerResult) {
            const $ = cheerio.load(puppeteerResult);
            const { sampleLinks, suggestedSelectors } = analyzeSelectors($, url);
            return { ok: true, statusCode: 200, method: 'puppeteer-stealth', sampleLinks, suggestedSelectors };
        }
        return { ok: false, statusCode: 0, method: 'all-failed', sampleLinks: [], suggestedSelectors: [] };
    }
}

// === Core: three-tier HTML fetching ===

async function fetchHtmlWithFallback(url: string): Promise<string | null> {
    // Tier 1: plain fetch
    const fetchResult = await fetchWithRetry(url);
    if (fetchResult) return fetchResult;

    // Tier 2: Puppeteer + Stealth (handles Cloudflare, JS-rendered pages)
    console.log(`[scraper] Falling back to Puppeteer for: ${url}`);
    const puppeteerResult = await fetchWithPuppeteer(url);
    if (puppeteerResult) return puppeteerResult;

    console.warn(`[scraper] All fetch methods failed for: ${url}`);
    return null;
}

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
};

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string | null> {
    for (let i = 0; i <= retries; i++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: BROWSER_HEADERS,
            });

            clearTimeout(timer);

            if (!response.ok) {
                // 403/503 → let caller try Puppeteer
                if (response.status === 403 || response.status === 503 || response.status === 429) {
                    return null;
                }
                console.warn(`[scraper] HTTP ${response.status} for ${url}`);
                continue;
            }

            return await response.text();
        } catch (err) {
            if (i === retries) return null;
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
    }
    return null;
}

async function fetchWithPuppeteer(url: string): Promise<string | null> {
    let browser: any = null;
    try {
        // Dynamic import to avoid loading puppeteer when not needed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const puppeteerExtra = await import('puppeteer-extra') as any;
        const StealthPlugin = await import('puppeteer-extra-plugin-stealth') as any;
        const puppeteer = puppeteerExtra.default ?? puppeteerExtra;
        puppeteer.use((StealthPlugin.default ?? StealthPlugin)());

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--window-size=1366,768',
            ],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9' });

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: PUPPETEER_TIMEOUT_MS,
        });

        // Wait a bit for Cloudflare challenge to resolve
        await page.waitForSelector('body', { timeout: 10_000 }).catch(() => { });
        const content = await page.content();
        return content;
    } catch (err) {
        console.warn(`[scraper] Puppeteer error for ${url}:`, err instanceof Error ? err.message : err);
        return null;
    } finally {
        if (browser) {
            await browser.close().catch(() => { });
        }
    }
}

// === Helpers ===

function makeInvalidArticle(link: ScrapedLink, reason: string): ExtractedArticle {
    return {
        url: link.url,
        title: link.title || '',
        rawText: '',
        rawHtml: '',
        extractedAt: new Date(),
        isValid: false,
        validationReason: reason,
        imageUrl: undefined,
    };
}

function resolveUrl(href: string, baseUrl: string): string | null {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return null;
    }
}

function isJunkUrl(url: string): boolean {
    return [
        /facebook\.com/, /twitter\.com/, /x\.com/, /instagram\.com/,
        /linkedin\.com/, /pinterest\.com/, /whatsapp\.com/, /aftermarket\.pl/,
        /sharer/, /share\?/, /\.(pdf|jpg|jpeg|png|gif|zip|docx?)$/i,
        /#$/, /mailto:/, /tel:/, /javascript:/,
    ].some((p) => p.test(url));
}

function analyzeSelectors($: ReturnType<typeof cheerio.load>, baseUrl: string) {
    const candidates = [
        'article a',
        '.news-list a',
        '.news a',
        'h2 a',
        'h3 a',
        '.post-content a',
        'main a',
    ];

    const results: { selector: string; count: number }[] = [];
    let bestLinks: string[] = [];

    for (const sel of candidates) {
        const links = new Set<string>();
        $(sel).each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const resolved = resolveUrl(href, baseUrl);
            if (resolved && !isJunkUrl(resolved)) links.add(resolved);
        });

        if (links.size > 0) {
            results.push({ selector: sel, count: links.size });
            if (bestLinks.length === 0) {
                bestLinks = Array.from(links).slice(0, 5);
            }
        }
    }

    // Sort by count descending, keep top 3
    results.sort((a, b) => b.count - a.count);

    return {
        sampleLinks: bestLinks.length > 0 ? bestLinks : extractSampleLinks($, baseUrl),
        suggestedSelectors: results.slice(0, 3)
    };
}

function extractSampleLinks($: ReturnType<typeof cheerio.load>, baseUrl: string): string[] {
    const links: string[] = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const resolved = resolveUrl(href, baseUrl);
        if (resolved && !isJunkUrl(resolved) && links.length < 5) {
            links.push(resolved);
        }
    });
    return links;
}
