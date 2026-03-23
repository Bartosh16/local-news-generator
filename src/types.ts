// === Portal z CSV ===
export interface PortalConfig {
    city: string;
    portalName: string;
    newsUrl: string;
    cssSelector: string;
    status: 'Działa' | 'Błąd';
    isCustom?: boolean;
}

// === Scraped news link ===
export interface ScrapedLink {
    url: string;
    title?: string;
    portal: PortalConfig;
}

// === Extracted article content ===
export interface ExtractedArticle {
    url: string;
    title: string;
    rawText: string;
    rawHtml: string;
    extractedAt: Date;
    isValid: boolean;
    validationReason?: string;
    imageUrl?: string;
}

// === Classified article ===
export interface ClassifiedArticle extends ExtractedArticle {
    classification: 'useful' | 'useless';
    classificationReason?: string;
}

// === Editorial brief from LLM ===
export interface EditorialBrief {
    text: string;
    sourceArticles: ClassifiedArticle[];
    city: string;
    tokensUsed: TokenUsage;
}

// === Final compiled article ready for DB ===
export interface CompiledArticle {
    city: string;
    portalBase: string;
    title: string;
    content: string;
    contentWithLinks: string;
    intro: string;
    metaTitle: string;
    metaDescription: string;
    headingsCount: { h2: number; h3: number };
    wordCount: number;
    imagePath: string;
    imageUrl: string;
    generationModel: string;
    generationTokensInput: number;
    generationTokensOutput: number;
    generationCostUsd: number;
    generationTimeMs: number;
    sourceUrls: string[];
    status: 'pending_quality';
}

// === Token usage tracking ===
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    model: string;
    costUsd: number;
}

// === LLM response ===
export interface LLMResponse {
    text: string;
    usage: TokenUsage;
}

// === LLM Client Protocol ===
export interface LLMClient {
    complete(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMOptions {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
}

// === Storage Adapter Protocol ===
export interface StorageAdapter {
    saveArticle(article: CompiledArticle): Promise<number>;
    checkDuplicate(city: string, date: Date): Promise<boolean>;
}

// === Pipeline status ===
export type PipelineStage =
    | 'idle'
    | 'scraping'
    | 'classifying'
    | 'editing'
    | 'compiling'
    | 'generating_meta'
    | 'generating_image'
    | 'saving'
    | 'done'
    | 'error';

export interface CityPipelineStatus {
    city: string;
    stage: PipelineStage;
    progress: string;
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
    articlesFound?: number;
    articlesUseful?: number;
}

// === Config ===
export interface AppConfig {
    llm: {
        openaiApiKey?: string;
        openrouterApiKey?: string;
        geminiApiKey?: string;
        classifierModel: string;
        editorModel: string;
        compilerModel: string;
    };
    mysql: {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        table: string;
    };
    ssh?: {
        host: string;
        port: number;
        user: string;
        privateKeyPath: string;
    };
    api?: {
        endpoint: string;
        token: string;
    };
    app: {
        concurrencyLimit: number;
        cronSchedule: string;
        port: number;
        logLevel: string;
        newsApiEnabled?: boolean;
    };
}
