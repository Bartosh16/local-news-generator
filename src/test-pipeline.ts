/**
 * End-to-end pipeline test script.
 * Usage: npx tsx src/test-pipeline.ts [--city "Opole"]
 *
 * Tets każdy krok pipeline'u i raportuje wyniki.
 */
import { loadConfig } from './config.js';
import { LocalStorageAdapter } from './storage/db-adapter.js';
import { loadAllPortals, getPortalsForCity } from './scraping/csv-parser.js';
import { fetchLinks, extractArticle } from './scraping/scraper.js';
import { classifyArticles } from './llm/classifier.js';
import { generateEditorialBrief } from './llm/editor.js';
import { compileArticle } from './llm/compiler.js';
import { createLLMClient } from './llm/llm-client.js';
import path from 'path';
import fs from 'fs';

const args = process.argv;
const cityIdx = args.indexOf('--city');
const CITY = cityIdx !== -1 && args[cityIdx + 1] ? args[cityIdx + 1] : 'Opole';
const CSV_PATH = path.resolve(process.cwd(), 'portale-newsowe.csv');

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  E2E Pipeline Test – ${CITY}`);
    console.log(`${'='.repeat(60)}\n`);

    const config = loadConfig();
    const storage = new LocalStorageAdapter('output');
    const errors: string[] = [];

    // ── Step 1: Load portals ──────────────────────────────────
    console.log('📋 Step 1: Ładowanie portali z CSV...');
    const allPortals = loadAllPortals(CSV_PATH);
    const portals = getPortalsForCity(allPortals, CITY);
    if (portals.length === 0) {
        console.error(`  ❌ Brak portali dla miasta: ${CITY}`);
        process.exit(1);
    }
    console.log(`  ✅ Znaleziono ${portals.length} portali`);
    portals.forEach((p) => console.log(`     • ${p.newsUrl} [${p.cssSelector}]`));

    // ── Step 2: Scrape links ──────────────────────────────────
    console.log('\n🕷️  Step 2: Scraping linków...');
    const allLinks = [];
    for (const portal of portals) {
        const links = await fetchLinks(portal);
        console.log(`  • ${portal.newsUrl}: ${links.length} linków`);
        allLinks.push(...links);
    }
    if (allLinks.length === 0) {
        console.error('  ❌ Brak linków – portal niedostępny lub zły CSS selector');
        errors.push('No links found');
    } else {
        console.log(`  ✅ Łącznie ${allLinks.length} linków`);
        allLinks.slice(0, 3).forEach((l) => console.log(`     • ${l.url}`));
    }

    if (errors.length > 0) {
        printSummary(errors);
        process.exit(1);
    }

    // ── Step 3: Extract articles ──────────────────────────────
    console.log('\n📰 Step 3: Ekstrakcja treści (max 5)...');
    const articles = [];
    for (let i = 0; i < Math.min(allLinks.length, 5); i++) {
        const article = await extractArticle(allLinks[i]);
        const status = article.isValid ? '✅' : '⚠️ ';
        console.log(`  ${status} [${article.isValid ? `${(article.rawText ?? '').split(/\s+/).length} słów` : article.validationReason}] ${article.url}`);
        if (article.isValid) articles.push(article);
    }
    if (articles.length === 0) {
        errors.push('No valid articles extracted');
    } else {
        console.log(`  ✅ ${articles.length} poprawnych artykułów`);
    }

    if (errors.length > 0) {
        printSummary(errors);
        process.exit(1);
    }

    // ── Step 4: Classify ──────────────────────────────────────
    console.log('\n🏷️  Step 4: Klasyfikacja LLM...');
    const classifierLlm = createLLMClient(config.llm.classifierModel, config);
    const classified = await classifyArticles(articles, CITY, classifierLlm);
    classified.forEach((a) =>
        console.log(`  ${a.classification === 'useful' ? '✅' : '❌'} [${a.classification}] ${a.title?.slice(0, 60)}`)
    );
    const useful = classified.filter((a) => a.classification === 'useful');
    if (useful.length === 0) {
        errors.push('All articles classified as useless');
    }
    console.log(`  ✅ ${useful.length}/${classified.length} wartościowych`);

    // ── Step 5: Editorial brief ──────────────────────────────
    console.log('\n✍️  Step 5: Brief redakcyjny...');
    const editorLlm = createLLMClient(config.llm.editorModel, config);
    const brief = await generateEditorialBrief(useful.slice(0, 3), CITY, editorLlm);
    const briefWords = brief.text.split(/\s+/).length;
    console.log(`  ✅ Brief: ${briefWords} słów (koszt: $${brief.tokensUsed.costUsd.toFixed(5)})`);
    if (briefWords < 100) errors.push(`Brief too short: ${briefWords} words`);

    // ── Step 6: Compile article ──────────────────────────────
    console.log('\n📝 Step 6: Kompilacja artykułu...');
    const compilerLlm = createLLMClient(config.llm.compilerModel, config);
    const compiled = await compileArticle(brief, compilerLlm);
    const wordCount = compiled.content.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length;
    console.log(`  ✅ Tytuł: "${compiled.title}"`);
    console.log(`  ✅ Treść: ${wordCount} słów (koszt: $${compiled.totalTokens.costUsd.toFixed(5)})`);
    if (wordCount < 300) errors.push(`Article too short: ${wordCount} words`);

    // ── Step 7: Save ──────────────────────────────────────────
    console.log('\n💾 Step 7: Zapis artykułu...');
    const finalArticle = {
        city: CITY,
        portalBase: portals[0]?.portalName ?? '',
        title: compiled.title,
        content: compiled.content,
        contentWithLinks: compiled.content,
        intro: compiled.intro,
        metaTitle: compiled.metaTitle,
        metaDescription: compiled.metaDescription,
        headingsCount: { h2: (compiled.content.match(/<h2/gi) || []).length, h3: (compiled.content.match(/<h3/gi) || []).length },
        wordCount,
        imagePath: '',
        imageUrl: '',
        generationModel: compiled.totalTokens.model,
        generationTokensInput: compiled.totalTokens.inputTokens + brief.tokensUsed.inputTokens,
        generationTokensOutput: compiled.totalTokens.outputTokens + brief.tokensUsed.outputTokens,
        generationCostUsd: compiled.totalTokens.costUsd + brief.tokensUsed.costUsd,
        generationTimeMs: 0,
        sourceUrls: useful.map((a) => a.url),
        status: 'pending_quality' as const,
    };
    const id = await storage.saveArticle(finalArticle);
    console.log(`  ✅ Zapisano z ID: ${id}`);

    printSummary(errors, finalArticle.generationCostUsd);
}

function printSummary(errors: string[], cost?: number) {
    console.log(`\n${'='.repeat(60)}`);
    if (errors.length === 0) {
        console.log('  ✅ TEST PASSED');
        if (cost !== undefined) console.log(`  Łączny koszt: $${cost.toFixed(5)}`);
    } else {
        console.log('  ❌ TEST FAILED');
        errors.forEach((e) => console.log(`  • ${e}`));
    }
    console.log('='.repeat(60));
}

main().catch((err) => {
    console.error('\n❌ FATAL:', err);
    process.exit(1);
});
