import type { StorageAdapter, CompiledArticle, AppConfig } from '../types.js';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

/**
 * Local JSON file storage adapter.
 * Saves articles as JSON files in the output directory.
 * Used as a default before MySQL is configured.
 *
 * Kontrakt:
 * - Input: CompiledArticle
 * - Output: article ID (auto-incremented)
 * - Side effect: writes JSON file to output/{city}/{date}.json
 */
export class LocalStorageAdapter implements StorageAdapter {
    private outputDir: string;

    constructor(outputDir: string) {
        this.outputDir = outputDir;
        fs.mkdirSync(this.outputDir, { recursive: true });
    }

    async saveArticle(article: CompiledArticle): Promise<number> {
        const cityDir = path.join(this.outputDir, article.city.toLowerCase().replace(/\s+/g, '-'));
        fs.mkdirSync(cityDir, { recursive: true });

        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `${dateStr}_${Date.now()}.json`;
        const filepath = path.join(cityDir, filename);

        const imageBase64 = article.imagePath && fs.existsSync(article.imagePath)
            ? fs.readFileSync(article.imagePath).toString('base64')
            : '';

        const data = {
            ...article,
            imageBase64,
            savedAt: new Date().toISOString(),
        };

        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[storage] Article saved: ${filepath}`);

        // Return a pseudo-ID based on timestamp
        return Date.now();
    }

    async checkDuplicate(city: string, date: Date): Promise<boolean> {
        const cityDir = path.join(this.outputDir, city.toLowerCase().replace(/\s+/g, '-'));
        if (!fs.existsSync(cityDir)) return false;

        const dateStr = date.toISOString().split('T')[0];
        const files = fs.readdirSync(cityDir);
        return files.some((f) => f.startsWith(dateStr));
    }
}

/**
 * REST API storage adapter for remote MySQL.
 * Sends articles via POST to a PHP endpoint on the client's server.
 *
 * Kontrakt:
 * - Input: CompiledArticle + endpoint URL + auth token
 * - Output: article ID from server response
 * - Errors: throws on HTTP error
 */
export class RestApiStorageAdapter implements StorageAdapter {
    private endpoint: string;
    private token: string;

    constructor(endpoint: string, token: string) {
        this.endpoint = endpoint;
        this.token = token;
    }

    async saveArticle(article: CompiledArticle): Promise<number> {
        const imageBase64 = article.imagePath && fs.existsSync(article.imagePath)
            ? fs.readFileSync(article.imagePath).toString('base64')
            : '';

        const body = {
            city_name: article.city,
            portal_base: article.portalBase,
            title: article.title,
            content: article.content,
            content_with_links: article.contentWithLinks,
            intro: article.intro,
            meta_title: article.metaTitle,
            meta_description: article.metaDescription,
            headings_count: JSON.stringify(article.headingsCount),
            word_count: article.wordCount,
            image_base64: imageBase64,
            generation_model: article.generationModel,
            generation_tokens_input: article.generationTokensInput,
            generation_tokens_output: article.generationTokensOutput,
            generation_cost_usd: article.generationCostUsd,
            generation_time_ms: article.generationTimeMs,
            source_urls: JSON.stringify(article.sourceUrls),
            status: article.status,
        };

        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`REST API error ${response.status}: ${err}`);
        }

        const result = (await response.json()) as { article_id?: number };
        return result.article_id ?? Date.now();
    }

    async checkDuplicate(city: string, date: Date): Promise<boolean> {
        // REST API doesn't support duplicate check in this implementation
        return false;
    }
}

/**
 * Direct MySQL storage adapter.
 * Connects directly to the client's MySQL database to insert the generated article.
 */
export class DirectMysqlStorageAdapter implements StorageAdapter {
    private pool: mysql.Pool;
    private table: string;

    constructor(dbConfig: AppConfig['mysql']) {
        this.table = dbConfig.table;
        this.pool = mysql.createPool({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password,
            database: dbConfig.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
        });

        // Test connection & setup table lazily
        this.pool.query('SELECT 1').then(() => {
            console.log(`[mysql] Połączono pomyślnie z bazą danych ${dbConfig.database}`);
            return this.ensureTableExists();
        }).catch(err => {
            console.error(`[mysql] Błąd połączenia z bazą danych: ${err.message}`);
        });
    }

    private async ensureTableExists() {
        // Basic schema accommodating the fields we have
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS \`${this.table}\` (
                id INT AUTO_INCREMENT PRIMARY KEY,
                city_name VARCHAR(255) NOT NULL,
                portal_base VARCHAR(255) NOT NULL,
                title VARCHAR(500) NOT NULL,
                content LONGTEXT NOT NULL,
                content_with_links LONGTEXT NOT NULL,
                intro TEXT NOT NULL,
                meta_title VARCHAR(255) NOT NULL,
                meta_description TEXT NOT NULL,
                headings_count JSON NOT NULL,
                word_count INT NOT NULL,
                image_base64 LONGTEXT,
                generation_model VARCHAR(100) NOT NULL,
                generation_tokens_input INT NOT NULL,
                generation_tokens_output INT NOT NULL,
                generation_cost_usd DECIMAL(10, 5) NOT NULL,
                generation_time_ms INT NOT NULL,
                source_urls JSON NOT NULL,
                status VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_city_name (city_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `;
        await this.pool.query(createTableSql);

        // Dla istniejących tabel: usuń duplikaty i dodaj UNIQUE KEY jeśli jeszcze nie istnieje
        await this.pool.query(`
            DELETE t1 FROM \`${this.table}\` t1
            INNER JOIN \`${this.table}\` t2
            WHERE t1.id < t2.id AND t1.city_name = t2.city_name
        `);
        await this.pool.query(`
            ALTER TABLE \`${this.table}\`
            ADD UNIQUE KEY uq_city_name (city_name)
        `).catch(() => { /* klucz już istnieje – ignoruj */ });
    }

    async saveArticle(article: CompiledArticle): Promise<number> {
        const imageBase64 = article.imagePath && fs.existsSync(article.imagePath)
            ? fs.readFileSync(article.imagePath).toString('base64')
            : '';

        const sql = `
            INSERT INTO \`${this.table}\` (
                city_name, portal_base, title, content, content_with_links, intro, meta_title, meta_description,
                headings_count, word_count, image_base64, generation_model, generation_tokens_input, generation_tokens_output,
                generation_cost_usd, generation_time_ms, source_urls, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                portal_base = VALUES(portal_base),
                title = VALUES(title),
                content = VALUES(content),
                content_with_links = VALUES(content_with_links),
                intro = VALUES(intro),
                meta_title = VALUES(meta_title),
                meta_description = VALUES(meta_description),
                headings_count = VALUES(headings_count),
                word_count = VALUES(word_count),
                image_base64 = VALUES(image_base64),
                generation_model = VALUES(generation_model),
                generation_tokens_input = VALUES(generation_tokens_input),
                generation_tokens_output = VALUES(generation_tokens_output),
                generation_cost_usd = VALUES(generation_cost_usd),
                generation_time_ms = VALUES(generation_time_ms),
                source_urls = VALUES(source_urls),
                status = VALUES(status),
                created_at = CURRENT_TIMESTAMP
        `;

        const values = [
            article.city,
            article.portalBase,
            article.title,
            article.content,
            article.contentWithLinks,
            article.intro,
            article.metaTitle,
            article.metaDescription,
            JSON.stringify(article.headingsCount),
            article.wordCount,
            imageBase64,
            article.generationModel,
            article.generationTokensInput,
            article.generationTokensOutput,
            article.generationCostUsd,
            article.generationTimeMs,
            JSON.stringify(article.sourceUrls),
            article.status
        ];

        const [result] = await this.pool.execute<mysql.ResultSetHeader>(sql, values);
        return result.insertId;
    }

    async checkDuplicate(city: string, date: Date): Promise<boolean> {
        // Simple duplicate check – if an article for this city was generated on this day
        const dayStart = date.toISOString().split('T')[0] + ' 00:00:00';
        const dayEnd = date.toISOString().split('T')[0] + ' 23:59:59';

        const sql = `SELECT id FROM \`${this.table}\` WHERE city_name = ? AND created_at BETWEEN ? AND ? LIMIT 1`;
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, [city, dayStart, dayEnd]);
        return rows.length > 0;
    }
}
