import type { ExtractedArticle, ClassifiedArticle, LLMClient } from '../types.js';

/**
 * Klasyfikuje artykuł jako useful/useless.
 * Prompt zaczerpnięty z n8n workflow.
 *
 * Kontrakt:
 * - Input: ExtractedArticle + nazwa miasta
 * - Output: ClassifiedArticle z polem classification ('useful' | 'useless')
 */
export async function classifyArticle(
    article: ExtractedArticle,
    city: string,
    llm: LLMClient
): Promise<ClassifiedArticle> {
    const systemPrompt = `Jesteś klasyfikatorem newsów. Twoim zadaniem jest ocenić, czy dany news jest WARTOŚCIOWY czy BEZWARTOŚCIOWY.

## Definicje

**WARTOŚCIOWY NEWS** to informacja o:
- Konkretnym wydarzeniu, które miało miejsce (wypadek, decyzja, otwarcie, zamknięcie, protest, spotkanie, odkrycie, awaria, interwencja)
- Unikalnej sytuacji wymagającej relacji dziennikarskiej
- Zmianie stanu rzeczy (nowe prawo, nowa inwestycja, zmiana personalna)
- Czymś, co "się stało" i ma konkretnych aktorów, miejsce, przyczynę lub skutek

**BEZWARTOŚCIOWY NEWS** to:
- Cykliczna kompilacja danych (pogoda, kolejki do lekarzy, wyniki loterii, kursy walut)
- Automatycznie generowane listy/zestawienia (trasy spacerowe, rowerowe, restauracje, atrakcje)
- Informacje typu "stan na dzień X" bez opisanego wydarzenia
- Treści, gdzie zmienia się tylko data, a reszta pozostaje taka sama
- Agregacje typu "gdzie kupić X", "ile kosztuje Y", "ranking Z"
- Horoskopy, przepisy kulinarne, poradniki sezonowe

## Kluczowe pytanie testowe

Zadaj sobie pytanie: "Czy ten news opisuje COŚ, CO SIĘ WYDARZYŁO, czy tylko STAN RZECZY / POWTARZALNĄ INFORMACJĘ?"

- Jeśli wydarzenie → WARTOŚCIOWY
- Jeśli stan/kompilacja/cykliczna informacja → BEZWARTOŚCIOWY

Newsy mają dotyczyć miasta: ${city}

Odpowiedz TYLKO jednym słowem: "useful" lub "useless".`;

    const userPrompt = `Tytuł: ${article.title}\n\nKrótki opis: ${article.rawText.slice(0, 500)}`;

    try {
        const response = await llm.complete(systemPrompt, userPrompt, {
            temperature: 0.1,
            maxTokens: 20,
        });

        const classification = response.text.toLowerCase().includes('useful') &&
            !response.text.toLowerCase().includes('useless')
            ? 'useful'
            : 'useless';

        return {
            ...article,
            classification,
            classificationReason: response.text.trim(),
        };
    } catch (err) {
        console.warn(`[classifier] Error classifying ${article.url}:`, err);
        // Default to useful on error – better to include than miss
        return {
            ...article,
            classification: 'useful',
            classificationReason: `Classification error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Klasyfikuje wiele artykułów, batchowo z limitem concurrency.
 */
export async function classifyArticles(
    articles: ExtractedArticle[],
    city: string,
    llm: LLMClient,
    concurrency = 5
): Promise<ClassifiedArticle[]> {
    const results: ClassifiedArticle[] = [];
    const queue = [...articles];

    while (queue.length > 0) {
        const batch = queue.splice(0, concurrency);
        const batchResults = await Promise.all(
            batch.map((article) => classifyArticle(article, city, llm))
        );
        results.push(...batchResults);
    }

    return results;
}
