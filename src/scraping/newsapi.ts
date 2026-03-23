import { loadConfig } from '../config.js';
import type { ScrapedLink } from '../types.js';

export async function fetchFromNewsApi(city: string): Promise<ScrapedLink[]> {
    const config = loadConfig();
    const apiKey = process.env.NEWSAPI_KEY;

    if (!apiKey) {
        console.warn(`[newsapi] Brak klucza NEWSAPI_KEY, pomijam dla ${city}`);
        return [];
    }

    // Ostatnie 24 godziny
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 1);
    const fromStr = fromDate.toISOString().split('T')[0];

    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(city)}&from=${fromStr}&sortBy=publishedAt&language=pl&apiKey=${apiKey}`;

    const links: ScrapedLink[] = [];
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[newsapi] Błąd API: ${res.status}`);
            return [];
        }

        const data = await res.json();
        const articles = data.articles || [];

        for (const a of articles.slice(0, 10)) { // Bierzemy top 10 najnowszych
            if (a.url && !links.find(l => l.url === a.url)) {
                links.push({
                    url: a.url,
                    title: a.title,
                    portal: {
                        city: city,
                        portalName: 'NewsAPI',
                        newsUrl: 'https://newsapi.org',
                        cssSelector: 'article',
                        status: 'Działa'
                    }
                });
            }
        }

    } catch (e) {
        console.error(`[newsapi] Błąd:`, e);
    }

    return links;
}
