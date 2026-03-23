import { parse } from 'csv-parse/sync';
import fs from 'fs';
import type { PortalConfig } from '../types.js';

const CUSTOM_JSON_PATH = 'portals-custom.json';

interface CustomJson {
    portals: Array<{
        city: string;
        portalName: string;
        newsUrl: string;
        cssSelector: string;
    }>;
    cities: string[];
}

/**
 * Parsuje plik portale-newsowe.csv → PortalConfig[]
 */
export function parsePortalsCsv(csvPath: string): PortalConfig[] {
    if (!fs.existsSync(csvPath)) {
        console.warn(`[csv-parser] CSV file not found: ${csvPath} — using only custom portals`);
        return [];
    }

    const raw = fs.readFileSync(csvPath, 'utf-8');
    const records = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
    }) as Record<string, string>[];

    const portals: PortalConfig[] = [];
    const seenUrls = new Set<string>();

    for (const row of records) {
        const status = row['Status']?.trim();
        const cssSelector = row['Selektor CSS']?.trim();
        const newsUrl = row['URL Newsów']?.trim();
        const city = row['Miasto']?.trim();
        const portalName = row['Nazwa portalu']?.trim();

        if (status !== 'Działa' || !cssSelector || !newsUrl) continue;

        const normalizedUrl = normalizeUrl(newsUrl);
        if (seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);

        portals.push({
            city: city || '',
            portalName: portalName || '',
            newsUrl,
            cssSelector,
            status: 'Działa',
        });
    }

    return portals;
}

/**
 * Ładuje niestandardowe portale z portals-custom.json
 */
export function loadCustomPortals(): PortalConfig[] {
    if (!fs.existsSync(CUSTOM_JSON_PATH)) return [];
    try {
        const data: CustomJson = JSON.parse(fs.readFileSync(CUSTOM_JSON_PATH, 'utf-8'));
        return (data.portals || []).map((p) => ({
            ...p,
            status: 'Działa' as const,
            isCustom: true,
        }));
    } catch { return []; }
}

/**
 * Ładuje niestandardowe miasta z portals-custom.json
 */
export function loadCustomCities(): string[] {
    if (!fs.existsSync(CUSTOM_JSON_PATH)) return [];
    try {
        const data: CustomJson = JSON.parse(fs.readFileSync(CUSTOM_JSON_PATH, 'utf-8'));
        return data.cities || [];
    } catch { return []; }
}

/**
 * Zapisuje nowy portal do portals-custom.json
 */
export function saveCustomPortal(portal: PortalConfig): void {
    const data = readCustomJson();
    // Avoid duplicates
    const exists = data.portals.some((p) => normalizeUrl(p.newsUrl) === normalizeUrl(portal.newsUrl));
    if (!exists) {
        data.portals.push({
            city: portal.city,
            portalName: portal.portalName || portal.city,
            newsUrl: portal.newsUrl,
            cssSelector: portal.cssSelector,
        });
        writeCustomJson(data);
    }
}

/**
 * Usuwa portal z portals-custom.json
 */
export function deleteCustomPortal(newsUrl: string): boolean {
    const data = readCustomJson();
    const before = data.portals.length;
    data.portals = data.portals.filter((p) => p.newsUrl !== newsUrl);
    writeCustomJson(data);
    return data.portals.length < before;
}

/**
 * Zapisuje nowe miasto do portals-custom.json
 */
export function saveCustomCity(city: string): void {
    const data = readCustomJson();
    if (!data.cities.includes(city)) {
        data.cities.push(city);
        writeCustomJson(data);
    }
}

/**
 * Zwraca wszystkie portale: CSV + custom. Deduplikowane per URL.
 */
export function loadAllPortals(csvPath: string): PortalConfig[] {
    const csvPortals = parsePortalsCsv(csvPath);
    const customPortals = loadCustomPortals();

    const seenUrls = new Set(csvPortals.map((p) => normalizeUrl(p.newsUrl)));
    const merged = [...csvPortals];

    for (const p of customPortals) {
        const norm = normalizeUrl(p.newsUrl);
        if (!seenUrls.has(norm)) {
            seenUrls.add(norm);
            merged.push(p);
        }
    }

    return merged;
}

/**
 * Zwraca unikalne miasta z listy portali + niestandardowe.
 */
export function getUniqueCities(portals: PortalConfig[]): string[] {
    const csvCities = [...new Set(portals.map((p) => p.city))];
    const customCities = loadCustomCities();
    // Deduplikacja case-insensitive: CSV ma priorytet, custom dodaje tylko nowe
    const seen = new Set(csvCities.map((c) => c.toLowerCase()));
    const merged = [...csvCities];
    for (const city of customCities) {
        if (city && !seen.has(city.toLowerCase())) {
            seen.add(city.toLowerCase());
            merged.push(city);
        }
    }
    return merged.filter(Boolean).sort();
}

/**
 * Filtruje portale dla danego miasta (CSV + custom).
 */
export function getPortalsForCity(portals: PortalConfig[], city: string): PortalConfig[] {
    return portals.filter((p) => p.city.toLowerCase() === city.toLowerCase());
}

// === Helpers ===

function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        return `${host}${u.pathname}`.replace(/\/$/, '');
    } catch { return url; }
}

function readCustomJson(): CustomJson {
    if (!fs.existsSync(CUSTOM_JSON_PATH)) return { portals: [], cities: [] };
    try { return JSON.parse(fs.readFileSync(CUSTOM_JSON_PATH, 'utf-8')); }
    catch { return { portals: [], cities: [] }; }
}

function writeCustomJson(data: CustomJson): void {
    fs.writeFileSync(CUSTOM_JSON_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
