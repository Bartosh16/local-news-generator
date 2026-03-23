import type { EditorialBrief, LLMClient, TokenUsage } from '../types.js';

interface CompilationResult {
    content: string;
    title: string;
    intro: string;
    metaTitle: string;
    metaDescription: string;
    totalTokens: TokenUsage;
}

/**
 * Kompiluje finalny artykuł HTML z briefu redakcyjnego.
 * Trzy osobne wywołania LLM: content, tytuł, intro (jak w n8n workflow).
 *
 * Kontrakt:
 * - Input: EditorialBrief + surowe treści artykułów
 * - Output: CompilationResult z content HTML, tytułem, intro, meta
 * - Invariant: content ≥ 500 słów, poprawny HTML
 */
export async function compileArticle(
    brief: EditorialBrief,
    llm: LLMClient
): Promise<CompilationResult> {
    const rawContent = brief.sourceArticles
        .map((a) => a.rawText.slice(0, 2000))
        .join('\n\n---\n\n');

    // === Step 1: Compile HTML content ===
    const contentResponse = await llm.complete(
        'Jesteś dziennikarzem lokalnym. Pisz w języku polskim.',
        `<wytyczne>
${brief.text}
</wytyczne>

<source>
${rawContent}
</source>

WAŻNE: Dzisiejsza data to ${new Date().toLocaleDateString('pl-PL')}. Uwzględnij to przy opisywaniu wydarzeń (odmieniaj jako "dzisiaj", "wczoraj", ew. odpowiednio bez podawania całych odległych dat o ile nie piszą o tym teksty źródłowe). Bezwzględnie unikaj zmyślania przyszłych dat (np. 'Kwiecień 2025').

Output w HTML.
Maks 3 zdania na akapit.
1 nagłowek h2, pozostałe nagłowki h3

News musi mieć minimum 500 słów.
Opisz jego znaczenie dla mieszkańców miasta ${brief.city}.

Odpowiedz TYLKO kodem HTML artykułu (bez tagów <html>, <body>, <head>). Zacznij od <h2>.`,
        { temperature: 0.7, maxTokens: 6000 }
    );

    // === Step 2: Generate title ===
    const titleResponse = await llm.complete(
        'Jesteś redaktorem. Generujesz tytuły artykułów.',
        `Dostaniesz zestaw newsów dotyczących pewnego miasta.
Twoim zadaniem będzie napisanie tytułu artykułu podsumowującego te newsy.

<newsy>
${contentResponse.text}
</newsy>

WAŻNE: Dzisiejsza data to ${new Date().toLocaleDateString('pl-PL')}. Nie podawaj w tytule zmyślonych przyszłych dat ani miesięcy.

Odpowiedz TYLKO tytułem artykułu (bez cudzysłowów, bez tagów HTML). Max 80 znaków.`,
        { temperature: 0.7, maxTokens: 200 }
    );

    // === Step 3: Generate intro ===
    const introResponse = await llm.complete(
        'Jesteś dziennikarzem. Pisz zwięzłe intro.',
        `Dostaniesz zestaw newsów dotyczących pewnego miasta.
Twoim zadaniem będzie napisanie intro artykułu podsumowującego te newsy - intro ma zajawiać temat, ale nie zdradzać szczegółów.

<newsy>
${contentResponse.text}
</newsy>

Odpowiedz TYLKO tekstem intro (2-3 zdania, bez tagów HTML).`,
        { temperature: 0.7, maxTokens: 500 }
    );

    // === Step 4: Generate meta title & description ===
    const metaResponse = await llm.complete(
        'Generujesz meta tagi SEO w języku polskim.',
        `Na podstawie tego artykułu wygeneruj:
1. meta_title (max 60 znaków) 
2. meta_description (max 155 znaków)

<artykuł>
${contentResponse.text.slice(0, 2000)}
</artykuł>

Odpowiedz w formacie JSON:
{"meta_title": "...", "meta_description": "..."}`,
        { temperature: 0.3, maxTokens: 300, jsonMode: true }
    );

    let metaTitle = titleResponse.text.trim().slice(0, 100);
    let metaDescription = '';

    try {
        const metaJson = JSON.parse(metaResponse.text);
        metaTitle = metaJson.meta_title || metaTitle;
        metaDescription = metaJson.meta_description || '';
    } catch {
        metaDescription = introResponse.text.trim().slice(0, 155);
    }

    // Aggregate token usage
    const totalTokens: TokenUsage = {
        inputTokens:
            contentResponse.usage.inputTokens +
            titleResponse.usage.inputTokens +
            introResponse.usage.inputTokens +
            metaResponse.usage.inputTokens,
        outputTokens:
            contentResponse.usage.outputTokens +
            titleResponse.usage.outputTokens +
            introResponse.usage.outputTokens +
            metaResponse.usage.outputTokens,
        model: contentResponse.usage.model,
        costUsd:
            contentResponse.usage.costUsd +
            titleResponse.usage.costUsd +
            introResponse.usage.costUsd +
            metaResponse.usage.costUsd,
    };

    return {
        content: contentResponse.text.trim(),
        title: titleResponse.text.trim(),
        intro: introResponse.text.trim(),
        metaTitle,
        metaDescription,
        totalTokens,
    };
}
