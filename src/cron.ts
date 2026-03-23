import cron from 'node-cron';
import path from 'path';
import type { AppConfig, StorageAdapter } from './types.js';
import { parsePortalsCsv, getUniqueCities } from './scraping/csv-parser.js';
import { runCityPipeline } from './pipeline.js';

const CSV_PATH = path.resolve(process.cwd(), 'portale-newsowe.csv');

/**
 * Uruchamia harmonogram cron.
 *
 * Kontrakt:
 * - Input: config z cronSchedule + storage adapter
 * - Side effect: uruchamia pipeline dla wszystkich miast wg harmonogramu
 */
export function startCron(config: AppConfig, storage: StorageAdapter): void {
    const schedule = config.app.cronSchedule;

    console.log(`[cron] Scheduling pipeline at: ${schedule}`);

    cron.schedule(schedule, async () => {
        console.log(`[cron] === Starting scheduled pipeline run ===`);
        const startTime = Date.now();

        try {
            const portals = parsePortalsCsv(CSV_PATH);
            const cities = getUniqueCities(portals);
            console.log(`[cron] Processing ${cities.length} cities...`);

            const batchSize = config.app.concurrencyLimit;
            let processed = 0;
            let succeeded = 0;
            let failed = 0;

            for (let i = 0; i < cities.length; i += batchSize) {
                const batch = cities.slice(i, i + batchSize);
                const results = await Promise.allSettled(
                    batch.map((city) => runCityPipeline(city, config, storage, CSV_PATH))
                );

                for (const result of results) {
                    processed++;
                    if (result.status === 'fulfilled' && result.value) {
                        succeeded++;
                    } else {
                        failed++;
                    }
                }

                console.log(`[cron] Progress: ${processed}/${cities.length} (${succeeded} ok, ${failed} failed)`);
            }

            const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
            console.log(`[cron] === Pipeline complete in ${elapsed} min: ${succeeded} articles, ${failed} failures ===`);
        } catch (err) {
            console.error(`[cron] Fatal error:`, err);
        }
    });
}
