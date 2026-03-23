/**
 * Test połączenia z bazą danych.
 * Usage: npx tsx src/test-db.ts
 *
 * Bez vendor lock-in: używa tego samego StorageAdapter co produkcja.
 * Obsługuje: LocalJSON, REST API, (przyszłościowo: bezpośredni MySQL).
 */
import { loadConfig } from './config.js';
import { LocalStorageAdapter, RestApiStorageAdapter } from './storage/db-adapter.js';
import type { CompiledArticle, StorageAdapter } from './types.js';

const TEST_ARTICLE: CompiledArticle = {
    city: 'TEST_CITY',
    portalBase: 'test-portal.pl',
    title: '[TEST] Artykuł testowy Local News Generator ' + new Date().toISOString(),
    content: '<h2>Test połączenia z bazą danych</h2><p>To jest testowy rekord wysłany przez Local News Generator. Jeśli widzisz ten tekst w bazie – połączenie działa poprawnie.</p>',
    contentWithLinks: '<h2>Test</h2><p>Test.</p>',
    intro: 'Testowy artykuł sprawdzający połączenie z bazą danych.',
    metaTitle: '[TEST] Local News Generator – test DB',
    metaDescription: 'Testowy rekord z Local News Generator.',
    headingsCount: { h2: 1, h3: 0 },
    wordCount: 25,
    imagePath: '',
    imageUrl: '',
    generationModel: 'test',
    generationTokensInput: 0,
    generationTokensOutput: 0,
    generationCostUsd: 0,
    generationTimeMs: 1,
    sourceUrls: ['https://example.com/test'],
    status: 'pending_quality',
};

async function main() {
    console.log('\n══════════════════════════════════════');
    console.log('  DB Connection Test – Local News Generator');
    console.log('══════════════════════════════════════\n');

    const config = loadConfig();

    let storage: StorageAdapter;
    let mode: string;

    if (config.api?.endpoint) {
        console.log(`Mode: REST API → ${config.api.endpoint}`);
        storage = new RestApiStorageAdapter(config.api.endpoint, config.api.token);
        mode = 'REST API';
    } else {
        console.log('Mode: Local JSON (storage/ folder)');
        console.log('ℹ️  Aby testować połączenie ze zdalną bazą, ustaw API_ENDPOINT i API_TOKEN w .env\n');
        storage = new LocalStorageAdapter('output');
        mode = 'Local JSON';
    }

    console.log('Wysyłanie testowego rekordu...');
    const startMs = Date.now();

    try {
        const id = await storage.saveArticle(TEST_ARTICLE);
        const elapsed = Date.now() - startMs;

        console.log('\n✅ SUKCES');
        console.log(`  Tryb:      ${mode}`);
        console.log(`  ID rekordu: ${id}`);
        console.log(`  Czas:       ${elapsed} ms`);

        if (mode === 'REST API') {
            console.log('\nSprawdź bazę danych klienta – powinien pojawić się rekord z tytułem:');
            console.log(`  "${TEST_ARTICLE.title}"`);
        } else {
            console.log('\nRekord zapisany w folderze output/test_city/');
        }
    } catch (err) {
        const elapsed = Date.now() - startMs;
        console.error('\n❌ BŁĄD połączenia');
        console.error(`  Tryb:  ${mode}`);
        console.error(`  Czas:  ${elapsed} ms`);
        console.error(`  Error: ${err instanceof Error ? err.message : err}`);

        if (mode === 'REST API') {
            console.log('\nPossible causes:');
            console.log('  • Endpoint URL niepoprawny');
            console.log('  • Token autoryzacyjny niepoprawny');
            console.log('  • Serwer klienta niedostępny');
            console.log('  • PHP endpoint nie istnieje lub ma błąd 500');
        }

        process.exit(1);
    }
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
