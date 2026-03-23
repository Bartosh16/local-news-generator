import type { ClassifiedArticle, EditorialBrief, LLMClient, TokenUsage } from '../types.js';

/**
 * Generuje brief redakcyjny z listy artykułów.
 * Prompt zaczerpnięty z n8n workflow (node "Redaktor").
 *
 * Kontrakt:
 * - Input: ClassifiedArticle[] (tylko 'useful') + nazwa miasta
 * - Output: EditorialBrief z tekstem briefu
 * - Invariant: brief ma ≥ 300 słów
 */
export async function generateEditorialBrief(
    articles: ClassifiedArticle[],
    city: string,
    llm: LLMClient
): Promise<EditorialBrief> {
    const rawContent = articles
        .map((a, i) => `--- Artykuł ${i + 1} ---\nŹródło: ${a.url}\nTytuł: ${a.title}\n\n${a.rawText.slice(0, 3000)}`)
        .join('\n\n');

    const systemPrompt = `Jesteś redaktorem naczelnym lokalnej gazety. Przetwarzasz surowe materiały źródłowe do briefu redakcyjnego.`;

    const userPrompt = `## Sytuacja
Jesteś redaktorem naczelnym lokalnej gazety w ${city}. Otrzymałeś surowe materiały źródłowe zawierające wiele wiadomości, które należy przetworzyć i przygotować do publikacji. Niektóre z tych informacji mogą być duplikatami lub dotyczyć podobnych tematów, które powinny zostać skonsolidowane.

WAŻNE: Dzisiejsza data to ${new Date().toLocaleDateString('pl-PL')}. Uwzględnij ten fakt w swoim tekście (nie wspominaj wprost "dzisiaj jest X", ale odpowiednio umiejscawiaj wydarzenia w czasie, np. pisząc "w najbliższy wtorek", "w ubiegły poniedziałek" itp., nie generuj fałszywych odległych dat w przyszłości ani dat historycznych o ile materiał źródłowy o nich nie mówi).

## Zadanie
Przeanalizuj dostarczony materiał źródłowy, zidentyfikuj i połącz powtarzające się wiadomości oraz stwórz ustrukturyzowane podsumowanie, które podkreśli znaczenie każdego newsa dla miasta ${city}. Sformatuj wynik jako instrukcje redakcyjne.

## Cel
Przekształcenie surowych treści informacyjnych w dobrze ustrukturyzowany brief redakcyjny, który konsoliduje informacje, eliminuje powtórzenia i koncentruje się na lokalnym znaczeniu dla docelowego miasta.

## Materiał źródłowy do analizy:
"""
${rawContent}
"""

## Docelowe miasto: ${city}

## Wymagania dotyczące wyniku
- Konsolidacja: Połącz zduplikowane lub nakładające się wiadomości w pojedyncze wpisy
- Lokalne znaczenie: Dla każdej wiadomości podsumuj, co dany temat oznacza dla ${city} i jego mieszkańców
- Struktura: Użyj jednego nagłówka H2 dla każdej unikalnej wiadomości, H3 dla podsekcji
- Ogranicz każdy akapit do max 3 zdań
- Minimum 500 słów
- Ton: Jasny, instruktażowy styl
- Koncentracja: Praktyczne konsekwencje i lokalny wpływ`;

    const response = await llm.complete(systemPrompt, userPrompt, {
        temperature: 0.5,
        maxTokens: 4096,
    });

    return {
        text: response.text,
        sourceArticles: articles,
        city,
        tokensUsed: response.usage,
    };
}
