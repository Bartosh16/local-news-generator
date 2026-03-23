import dotenv from 'dotenv';
import type { AppConfig } from './types.js';

dotenv.config();

function env(key: string, fallback?: string): string {
    const value = process.env[key] ?? fallback;
    if (value === undefined) {
        throw new Error(`Missing required env variable: ${key}`);
    }
    return value;
}

function envOptional(key: string): string | undefined {
    return process.env[key];
}

export function loadConfig(): AppConfig {
    return {
        llm: {
            openaiApiKey: envOptional('OPENAI_API_KEY'),
            openrouterApiKey: envOptional('OPENROUTER_API_KEY'),
            geminiApiKey: envOptional('GOOGLE_GEMINI_API_KEY'),
            classifierModel: env('CLASSIFIER_MODEL', 'gpt-4.1-nano'),
            editorModel: env('EDITOR_MODEL', 'gemini-2.5-flash'),
            compilerModel: env('COMPILER_MODEL', 'gpt-4.1-mini'),
        },
        mysql: {
            host: env('MYSQL_HOST', '127.0.0.1'),
            port: parseInt(env('MYSQL_PORT', '3306'), 10),
            user: env('MYSQL_USER', ''),
            password: env('MYSQL_PASSWORD', ''),
            database: env('MYSQL_DATABASE', ''),
            table: env('MYSQL_TABLE', 'articles'),
        },
        ssh: envOptional('SSH_HOST')
            ? {
                host: env('SSH_HOST'),
                port: parseInt(env('SSH_PORT', '22'), 10),
                user: env('SSH_USER'),
                privateKeyPath: env('SSH_PRIVATE_KEY_PATH'),
            }
            : undefined,
        api: envOptional('API_ENDPOINT')
            ? {
                endpoint: env('API_ENDPOINT'),
                token: env('API_TOKEN'),
            }
            : undefined,
        app: {
            concurrencyLimit: parseInt(env('CONCURRENCY_LIMIT', '5'), 10),
            cronSchedule: env('CRON_SCHEDULE', '0 6 * * *'),
            port: parseInt(env('PORT', '3000'), 10),
            logLevel: env('LOG_LEVEL', 'info'),
            newsApiEnabled: envOptional('NEWSAPI_ENABLED') !== 'false',
        },
    };
}
