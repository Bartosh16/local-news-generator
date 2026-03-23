import OpenAI from 'openai';
import type { LLMClient, LLMResponse, LLMOptions, AppConfig } from '../types.js';

// Cost per 1M tokens (approximate, USD)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'gpt-4.1-nano': { input: 0.10, output: 0.40 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
};

/**
 * Tworzy LLM client dla danego modelu.
 * Gemini jest automatycznie owijany w FallbackLLMClient → przy błędzie przełącza na OpenAI.
 *
 * Kontrakt:
 * - Input: model name + config
 * - Output: LLMClient (może być FallbackLLMClient dla Gemini)
 * - Errors: throws jeśli brak API key dla wszystkich dostępnych providerów
 */
export function createLLMClient(model: string, config: AppConfig): LLMClient {
    if (model.startsWith('gemini')) {
        const primary = new GeminiClient(model, config.llm.geminiApiKey || '');
        // Fallback: OpenAI-compatible equivalent (gpt-4.1-mini)
        const fallbackModel = 'gpt-4.1-mini';
        const fallbackApiKey = config.llm.openaiApiKey || config.llm.openrouterApiKey;
        if (fallbackApiKey) {
            const baseUrl = config.llm.openrouterApiKey && !config.llm.openaiApiKey
                ? 'https://openrouter.ai/api/v1'
                : undefined;
            const fallback = new OpenAIClient(fallbackModel, fallbackApiKey, baseUrl);
            return new FallbackLLMClient(primary, fallback, `${model} → ${fallbackModel}`);
        }
        return primary;
    }

    const apiKey = config.llm.openaiApiKey || config.llm.openrouterApiKey;
    const baseUrl = config.llm.openrouterApiKey && !config.llm.openaiApiKey
        ? 'https://openrouter.ai/api/v1'
        : undefined;

    if (!apiKey) {
        throw new Error(`No API key configured for model: ${model}`);
    }

    return new OpenAIClient(model, apiKey, baseUrl);
}

/**
 * Wraps primary + fallback LLM client.
 * On any error from primary, automatically retries with fallback.
 */
class FallbackLLMClient implements LLMClient {
    constructor(
        private primary: LLMClient,
        private fallback: LLMClient,
        private label: string
    ) { }

    async complete(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResponse> {
        try {
            return await this.primary.complete(systemPrompt, userPrompt, options);
        } catch (err) {
            console.warn(`[llm] Primary failed (${this.label}), switching to fallback:`, err instanceof Error ? err.message : err);
            return await this.fallback.complete(systemPrompt, userPrompt, options);
        }
    }
}

class OpenAIClient implements LLMClient {
    private client: OpenAI;
    private model: string;

    constructor(model: string, apiKey: string, baseUrl?: string) {
        this.model = model;
        this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    }

    async complete(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResponse> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: options?.temperature ?? 0.7,
            max_completion_tokens: options?.maxTokens ?? 4096,
            ...(options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        });

        const inputTokens = response.usage?.prompt_tokens ?? 0;
        const outputTokens = response.usage?.completion_tokens ?? 0;
        const costs = MODEL_COSTS[this.model] ?? { input: 1.0, output: 3.0 };
        const costUsd = (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;

        return {
            text: response.choices[0]?.message?.content ?? '',
            usage: { inputTokens, outputTokens, model: this.model, costUsd },
        };
    }
}

class GeminiClient implements LLMClient {
    constructor(private model: string, private apiKey: string) { }

    async complete(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResponse> {
        if (!this.apiKey) {
            throw new Error('Gemini API key not configured');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        const body = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: {
                temperature: options?.temperature ?? 0.7,
                maxOutputTokens: options?.maxTokens ?? 4096,
                ...(options?.jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini API error ${response.status}: ${err.slice(0, 200)}`);
        }

        const data = await response.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        const costs = MODEL_COSTS[this.model] ?? { input: 0.15, output: 0.60 };
        const costUsd = (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;

        return { text, usage: { inputTokens, outputTokens, model: this.model, costUsd } };
    }
}
