import express from 'express';
import path from 'path';
import fs from 'fs';
import type { AppConfig, CityPipelineStatus, StorageAdapter, CompiledArticle } from './types.js';
import {
    loadAllPortals, getUniqueCities, getPortalsForCity,
    saveCustomPortal, deleteCustomPortal, saveCustomCity, loadCustomPortals,
} from './scraping/csv-parser.js';
import { runCityPipeline } from './pipeline.js';
import { N8nWorkflowBuilder } from './n8n/workflow-builder.js';
import { createCrawlerSelectorService } from './crawler-selector/index.js';

const CSV_PATH = path.resolve(process.cwd(), 'portale-newsowe.csv');

// In-memory tracking
const cityStatuses = new Map<string, CityPipelineStatus>();
const recentArticles: Array<{
    city: string; title: string; wordCount: number; cost: number; time: string; filename?: string; content: string;
}> = [];

export function createServer(config: AppConfig, storage: StorageAdapter): express.Express {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.static(path.resolve(process.cwd(), 'public')));

    // ─── Settings ───────────────────────────────────────────────

    app.get('/api/settings', (_req, res) => {
        res.json({
            compilerModel: config.llm.compilerModel,
            editorModel: config.llm.editorModel,
            newsApiEnabled: config.app.newsApiEnabled !== false,
        });
    });

    app.post('/api/settings', (req, res) => {
        const { compilerModel, editorModel, newsApiEnabled } = req.body;

        let envVal = '';
        try { envVal = fs.readFileSync('.env', 'utf-8'); } catch { }

        if (compilerModel) {
            config.llm.compilerModel = compilerModel;
            envVal = envVal.includes('COMPILER_MODEL=')
                ? envVal.replace(/COMPILER_MODEL=.*/, `COMPILER_MODEL=${compilerModel}`)
                : envVal + `\nCOMPILER_MODEL=${compilerModel}`;
        }

        if (editorModel) {
            config.llm.editorModel = editorModel;
            envVal = envVal.includes('EDITOR_MODEL=')
                ? envVal.replace(/EDITOR_MODEL=.*/, `EDITOR_MODEL=${editorModel}`)
                : envVal + `\nEDITOR_MODEL=${editorModel}`;
        }

        if (newsApiEnabled !== undefined) {
            config.app.newsApiEnabled = newsApiEnabled;
            envVal = envVal.includes('NEWSAPI_ENABLED=')
                ? envVal.replace(/NEWSAPI_ENABLED=.*/, `NEWSAPI_ENABLED=${newsApiEnabled}`)
                : envVal + `\nNEWSAPI_ENABLED=${newsApiEnabled}`;
        }

        fs.writeFileSync('.env', envVal.trim() + '\n', 'utf-8');
        res.json({ ok: true });
    });

    // ─── Cities ─────────────────────────────────────────────────

    app.get('/api/cities', (_req, res) => {
        try {
            const portals = loadAllPortals(CSV_PATH);
            const cities = getUniqueCities(portals);
            const result = cities.map((city) => ({
                name: city,
                portalCount: portals.filter((p) => p.city === city).length,
                portals: portals.filter((p) => p.city === city).map((p) => ({
                    name: p.portalName, url: p.newsUrl, selector: p.cssSelector,
                    isCustom: p.isCustom === true,
                })),
                status: cityStatuses.get(city) ?? { city, stage: 'idle', progress: 'Oczekuje' },
            }));
            res.json({ cities: result, total: cities.length });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // Add city manually
    app.post('/api/cities', (req, res) => {
        const { name } = req.body as { name?: string };
        if (!name?.trim()) {
            res.status(400).json({ error: 'City name required' });
            return;
        }
        saveCustomCity(name.trim());
        res.json({ ok: true, city: name.trim() });
    });

    // ─── N8n Workflow Export ────────────────────────────────────

    app.get('/api/n8n-json/:city', (req, res) => {
        try {
            const city = decodeURIComponent(req.params.city);
            const builder = new N8nWorkflowBuilder();
            const workflowJson = builder.build({ cityName: city });

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${city}.json"`);
            res.send(JSON.stringify(workflowJson, null, 2));
        } catch (err: any) {
            console.error('Błąd generowania JSON n8n:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── Portals ─────────────────────────────────────────────────

    app.post('/api/portals/check', async (req, res) => {
        const { url } = req.body as { url?: string };
        if (!url) { res.status(400).json({ error: 'URL required' }); return; }

        try {
            const service = createCrawlerSelectorService();
            const result = await service.extractNewsList({ url });
            
            // Mapujemy nasz nowy, precyzyjny selektor na stary format, z którego korzysta UI
            res.json({
                ok: true,
                statusCode: 200,
                method: 'crawler-selector',
                sampleLinks: result.newsUrls.slice(0, 5),
                suggestedSelectors: [
                    { selector: result.cssSelector, count: result.newsUrls.length }
                ]
            });
        } catch (err: any) {
            console.error('Check fail:', err);
            res.status(500).json({ error: String(err), ok: false, method: 'error' });
        }
    });

    // Add portal to a city
    app.post('/api/portals', (req, res) => {
        const { city, url, cssSelector, portalName } = req.body as {
            city?: string; url?: string; cssSelector?: string; portalName?: string;
        };
        if (!city || !url || !cssSelector) {
            res.status(400).json({ error: 'city, url and cssSelector required' });
            return;
        }
        saveCustomPortal({
            city, newsUrl: url, cssSelector,
            portalName: portalName || new URL(url).hostname,
            status: 'Działa',
        });
        res.json({ ok: true });
    });

    // Delete portal
    app.delete('/api/portals', (req, res) => {
        const { url } = req.body as { url?: string };
        if (!url) { res.status(400).json({ error: 'url required' }); return; }
        const deleted = deleteCustomPortal(url);
        res.json({ ok: deleted });
    });

    // ─── Pipeline ─────────────────────────────────────────────────

    app.post('/api/run/:city', async (req, res) => {
        const city = decodeURIComponent(req.params.city);
        const current = cityStatuses.get(city);
        if (current && !['idle', 'done', 'error'].includes(current.stage)) {
            res.status(409).json({ error: `Pipeline already running for ${city}` });
            return;
        }

        res.json({ message: `Pipeline started for ${city}` });

        runCityPipeline(city, config, storage, CSV_PATH, (status) => {
            cityStatuses.set(city, status);
        }).then((article) => {
            if (article) {
                recentArticles.unshift({
                    city: article.city, title: article.title,
                    wordCount: article.wordCount, cost: article.generationCostUsd,
                    time: new Date().toLocaleString('pl-PL'),
                    content: article.content,
                });
                if (recentArticles.length > 50) recentArticles.length = 50;
            }
        });
    });

    app.post('/api/run-all', async (_req, res) => {
        const portals = loadAllPortals(CSV_PATH);
        const cities = getUniqueCities(portals);
        res.json({ message: `Pipeline started for ${cities.length} cities` });

        const batchSize = config.app.concurrencyLimit;
        for (let i = 0; i < cities.length; i += batchSize) {
            const batch = cities.slice(i, i + batchSize);
            await Promise.allSettled(batch.map((city) =>
                runCityPipeline(city, config, storage, CSV_PATH, (status) => {
                    cityStatuses.set(city, status);
                }).then((article) => {
                    if (article) {
                        recentArticles.unshift({
                            city: article.city, title: article.title,
                            wordCount: article.wordCount, cost: article.generationCostUsd,
                            time: new Date().toLocaleString('pl-PL'),
                            content: article.content,
                        });
                    }
                })
            ));
        }
    });

    // ─── Status ─────────────────────────────────────────────────

    app.get('/api/status', (_req, res) => {
        const statuses = Array.from(cityStatuses.values());
        const running = statuses.filter((s) => !['idle', 'done', 'error'].includes(s.stage));
        res.json({ running: running.length, total: statuses.length, statuses });
    });

    app.get('/api/articles', (_req, res) => {
        res.json({ articles: recentArticles });
    });

    // Get article HTML (fallback or freshly generated)
    app.get('/api/article/:city', (req, res) => {
        const city = decodeURIComponent(req.params.city);
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `${city.toLowerCase().replace(/\s+/g, '-')}_${dateStr}.html`;
        const filepath = path.resolve(process.cwd(), 'output', 'articles', filename);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: `Artykuł dla miasta ${city} nie znaleziony` });
        }

        res.type('text/html').sendFile(filepath);
    });

    // ─── DB Test ─────────────────────────────────────────────────

    app.post('/api/test-db', async (_req, res) => {
        const testArticle: CompiledArticle = {
            city: 'TEST_CITY',
            portalBase: 'test-portal.pl',
            title: '[TEST] Artykuł testowy Local News Generator',
            content: '<h2>Test połączenia z bazą danych</h2><p>To jest testowy rekord wysłany przez Local News Generator.</p>',
            contentWithLinks: '<h2>Test</h2><p>Test.</p>',
            intro: 'Testowy artykuł sprawdzający połączenie z bazą danych.',
            metaTitle: '[TEST] Local News Generator – test DB',
            metaDescription: 'Testowy rekord z Local News Generator.',
            headingsCount: { h2: 1, h3: 0 },
            wordCount: 12,
            imagePath: '',
            imageUrl: '',
            generationModel: 'test',
            generationTokensInput: 0,
            generationTokensOutput: 0,
            generationCostUsd: 0,
            generationTimeMs: 1,
            sourceUrls: ['https://example.com'],
            status: 'pending_quality',
        };

        try {
            const startMs = Date.now();
            const id = await storage.saveArticle(testArticle);
            const elapsed = Date.now() - startMs;
            res.json({ ok: true, article_id: id, elapsed_ms: elapsed, message: `Rekord testowy zapisany z ID: ${id}` });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    // ─── Output files ─────────────────────────────────────────────

    app.get('/api/output/:city', (req, res) => {
        const city = decodeURIComponent(req.params.city);
        const cityDir = path.resolve(process.cwd(), 'output', city.toLowerCase().replace(/\s+/g, '-'));
        try {
            if (!fs.existsSync(cityDir)) { res.json({ articles: [] }); return; }
            const files = fs.readdirSync(cityDir).filter((f) => f.endsWith('.json')).sort().reverse();
            const articles = files.slice(0, 10).map((f) => {
                const content = JSON.parse(fs.readFileSync(path.join(cityDir, f), 'utf-8'));
                return { filename: f, ...content };
            });
            res.json({ articles });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    return app;
}
