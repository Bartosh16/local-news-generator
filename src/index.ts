import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { startCron } from './cron.js';
import { LocalStorageAdapter, RestApiStorageAdapter, DirectMysqlStorageAdapter } from './storage/db-adapter.js';
import type { StorageAdapter } from './types.js';

async function main() {
    console.log('=== Local News Generator ===');
    console.log(`Started at: ${new Date().toLocaleString('pl-PL')}`);

    const config = loadConfig();

    // Choose storage adapter
    let storage: StorageAdapter;
    if (config.api?.endpoint) {
        console.log(`[init] Using REST API storage: ${config.api.endpoint}`);
        storage = new RestApiStorageAdapter(config.api.endpoint, config.api.token);
    } else if (config.mysql?.database) {
        console.log(`[init] Using Direct MySQL storage: ${config.mysql.host}/${config.mysql.database}`);
        storage = new DirectMysqlStorageAdapter(config.mysql);
    } else {
        console.log('[init] Using local JSON storage (output/)');
        storage = new LocalStorageAdapter('output');
    }

    // Start Express server
    const app = createServer(config, storage);
    app.listen(config.app.port, () => {
        console.log(`[server] Dashboard: http://localhost:${config.app.port}`);
    });

    // Start cron scheduler
    startCron(config, storage);

    // Handle --run-once --city <name> CLI mode
    const args = process.argv;
    const runOnceIdx = args.indexOf('--run-once');
    const cityIdx = args.indexOf('--city');

    if (runOnceIdx !== -1 && cityIdx !== -1 && args[cityIdx + 1]) {
        const city = args[cityIdx + 1];
        console.log(`\n[cli] Running one-shot pipeline for: ${city}\n`);

        const { runCityPipeline } = await import('./pipeline.js');
        const result = await runCityPipeline(city, config, storage, 'portale-newsowe.csv', (status) => {
            console.log(`  [${status.stage}] ${status.progress}`);
        });

        if (result) {
            console.log(`\n✅ Article generated: "${result.title}"`);
            console.log(`   Words: ${result.wordCount}, Cost: $${result.generationCostUsd.toFixed(4)}`);
            console.log(`   Image: ${result.imagePath}`);
            console.log(`   Time: ${result.generationTimeMs}ms`);
        } else {
            console.log('\n❌ No article generated');
        }

        if (runOnceIdx !== -1) {
            process.exit(0);
        }
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
