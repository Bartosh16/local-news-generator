import path from 'path';
import fs from 'fs';
import type { AppConfig, CompiledArticle, CityPipelineStatus, PortalConfig, StorageAdapter } from './types.js';
import { loadAllPortals, getPortalsForCity } from './scraping/csv-parser.js';
import { fetchLinks, extractArticle } from './scraping/scraper.js';
import { fetchFromNewsApi } from './scraping/newsapi.js';
import { classifyArticles } from './llm/classifier.js';
import { generateEditorialBrief } from './llm/editor.js';
import { compileArticle } from './llm/compiler.js';
import { generateFeaturedImage } from './image/image-generator.js';
import { createLLMClient } from './llm/llm-client.js';

/**
 * Orkiestruje cały pipeline dla jednego miasta.
 *
 * Kontrakt:
 * - Input: city name + config + storage adapter + status callback
 * - Output: CompiledArticle | null (null jeśli za mało danych)
 * - Side effects: zapisuje artykuł do storage, generuje obrazek
 */
export async function runCityPipeline(
    city: string,
    config: AppConfig,
    storage: StorageAdapter,
    csvPath: string,
    onStatus?: (status: CityPipelineStatus) => void
): Promise<CompiledArticle | null> {
    const startTime = Date.now();

    const updateStatus = (stage: CityPipelineStatus['stage'], progress: string, extra?: Partial<CityPipelineStatus>) => {
        onStatus?.({
            city,
            stage,
            progress,
            startedAt: new Date(startTime),
            ...extra,
        });
    };

    try {
        // === 1. Get portals for this city ===
        updateStatus('scraping', 'Pobieranie portali z CSV...');
        const allPortals = loadAllPortals(csvPath);
        const portals = getPortalsForCity(allPortals, city);

        if (portals.length === 0) {
            updateStatus('error', `Brak portali dla miasta: ${city}`);
            return null;
        }

        console.log(`[pipeline] ${city}: Found ${portals.length} portals`);

        // === 2. Scrape links from all portals ===
        updateStatus('scraping', `Scrapowanie ${portals.length} portali...`);
        const allLinks = [];
        for (const portal of portals) {
            try {
                const links = await fetchLinks(portal);
                allLinks.push(...links);
                console.log(`[pipeline] ${city}: ${links.length} links from ${portal.newsUrl}`);
            } catch (err) {
                console.warn(`[pipeline] ${city}: Error scraping ${portal.newsUrl}:`, err);
            }
        }

        // Add NewsAPI Links
        if (config.app.newsApiEnabled !== false) {
            updateStatus('scraping', `Pobieranie z NewsAPI (ostatnie 24h)...`);
            try {
                const newsApiLinks = await fetchFromNewsApi(city);
                allLinks.push(...newsApiLinks);
                console.log(`[pipeline] ${city}: ${newsApiLinks.length} links from NewsAPI`);
            } catch (err) {
                console.warn(`[pipeline] ${city}: Error fetching NewsAPI:`, err);
            }
        }

        if (allLinks.length === 0) {
            updateStatus('error', 'Nie znaleziono żadnych linków');
            return null;
        }

        console.log(`[pipeline] ${city}: Total ${allLinks.length} links found`);

        // === 3. Extract article content ===
        updateStatus('scraping', `Ekstrakcja treści z ${allLinks.length} artykułów...`);
        const articles = [];
        // Process in batches of 5
        for (let i = 0; i < Math.min(allLinks.length, 15); i++) {
            try {
                const article = await extractArticle(allLinks[i]);
                if (article.isValid) {
                    articles.push(article);
                }
            } catch (err) {
                console.warn(`[pipeline] ${city}: Error extracting ${allLinks[i].url}:`, err);
            }
        }

        if (articles.length === 0) {
            updateStatus('error', 'Nie udało się wyekstrahować żadnych artykułów');
            return null;
        }

        console.log(`[pipeline] ${city}: ${articles.length} valid articles extracted`);
        updateStatus('classifying', `Klasyfikacja ${articles.length} artykułów...`, {
            articlesFound: allLinks.length,
        });

        // === 4. Classify articles ===
        const classifierLlm = createLLMClient(config.llm.classifierModel, config);
        const classified = await classifyArticles(articles, city, classifierLlm);
        const useful = classified.filter((a) => a.classification === 'useful');

        console.log(`[pipeline] ${city}: ${useful.length}/${classified.length} useful articles`);

        if (useful.length === 0) {
            updateStatus('error', 'Brak wartościowych artykułów po klasyfikacji');
            return null;
        }

        updateStatus('editing', `Tworzenie briefu z ${useful.length} artykułów...`, {
            articlesUseful: useful.length,
        });

        // === 5. Generate editorial brief ===
        const editorLlm = createLLMClient(config.llm.editorModel, config);
        const brief = await generateEditorialBrief(useful, city, editorLlm);
        console.log(`[pipeline] ${city}: Editorial brief generated (${brief.tokensUsed.inputTokens + brief.tokensUsed.outputTokens} tokens)`);

        // === 6. Compile article ===
        updateStatus('compiling', 'Kompilacja artykułu HTML...');
        const compilerLlm = createLLMClient(config.llm.compilerModel, config);
        const compiled = await compileArticle(brief, compilerLlm);
        console.log(`[pipeline] ${city}: Article compiled: "${compiled.title}"`);

        // === 7. Generate image ===
        updateStatus('generating_image', 'Generowanie obrazka...');
        const outputDir = path.resolve(process.cwd(), 'output', 'images');
        const imagePath = await generateFeaturedImage(city, new Date(), outputDir);
        console.log(`[pipeline] ${city}: Image generated: ${imagePath}`);

        // === 8. Count headings and words ===
        const h2Count = (compiled.content.match(/<h2/gi) || []).length;
        const h3Count = (compiled.content.match(/<h3/gi) || []).length;
        const wordCount = compiled.content.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length;

        const endTime = Date.now();

        // === 9. Build final article ===
        const finalArticle: CompiledArticle = {
            city,
            portalBase: portals[0].portalName,
            title: compiled.title,
            content: compiled.content,
            contentWithLinks: compiled.content, // TODO: add source links
            intro: compiled.intro,
            metaTitle: compiled.metaTitle,
            metaDescription: compiled.metaDescription,
            headingsCount: { h2: h2Count, h3: h3Count },
            wordCount,
            imagePath,
            imageUrl: useful[0]?.imageUrl || '',
            generationModel: compiled.totalTokens.model,
            generationTokensInput: compiled.totalTokens.inputTokens,
            generationTokensOutput: compiled.totalTokens.outputTokens,
            generationCostUsd: compiled.totalTokens.costUsd + brief.tokensUsed.costUsd,
            generationTimeMs: endTime - startTime,
            sourceUrls: useful.map((a) => a.url),
            status: 'pending_quality',
        };

        // === 10. Save ===
        updateStatus('saving', 'Zapisywanie artykułu...');
        try {
            const articleId = await storage.saveArticle(finalArticle);
            console.log(`[pipeline] ${city}: Article saved with ID ${articleId}`);
        } catch (dbErr) {
            console.warn(`[pipeline] ${city}: Failed to save to DB, saving HTML fallback:`, dbErr);
            // Fallback na HTML — zawsze możemy pobrać artykuł
            await saveArticleAsHtml(city, compiled, useful[0]?.imageUrl || '');
        }

        updateStatus('done', `Gotowe! Artykuł "${compiled.title}" (${wordCount} słów)`, {
            completedAt: new Date(),
        });

        return finalArticle;
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] ${city}: Fatal error:`, errorMsg);
        updateStatus('error', `Błąd: ${errorMsg}`);
        return null;
    }
}

/**
 * Zapisuje artykuł jako HTML z metadanymi
 */
async function saveArticleAsHtml(city: string, compiled: any, imageUrl: string): Promise<void> {
    const articleDir = path.resolve(process.cwd(), 'output', 'articles');
    fs.mkdirSync(articleDir, { recursive: true });

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${city.toLowerCase().replace(/\s+/g, '-')}_${dateStr}.html`;
    const filepath = path.join(articleDir, filename);

    const html = `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(compiled.metaTitle)}</title>
    <meta name="description" content="${escapeHtml(compiled.metaDescription)}">
    <meta property="og:title" content="${escapeHtml(compiled.metaTitle)}">
    <meta property="og:description" content="${escapeHtml(compiled.metaDescription)}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; color: #333; }
        article { background: #f9f9f9; padding: 30px; border-radius: 8px; }
        h1 { color: #222; margin-top: 0; }
        img { max-width: 100%; height: auto; margin: 20px 0; border-radius: 4px; }
        a { color: #0066cc; }
    </style>
</head>
<body>
    <article>
        <h1>${escapeHtml(compiled.metaTitle)}</h1>
        ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(compiled.metaTitle)}">` : ''}
        <p><em>${escapeHtml(compiled.intro)}</em></p>
        ${compiled.content}
        <hr>
        <p><small>Wygenerowano: ${new Date().toLocaleString('pl-PL')}</small></p>
    </article>
</body>
</html>`;

    fs.writeFileSync(filepath, html, 'utf-8');
    console.log(`[pipeline] Artykuł zapisany jako HTML: ${filepath}`);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
