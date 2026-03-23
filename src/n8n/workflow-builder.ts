import fs from 'fs';
import path from 'path';

// --- Kontrakt wg "GLOBAL AI AGENT GUIDELINES" ---

/**
 * Parametry wejściowe dla generatora workflow n8n
 */
export interface N8nWorkflowParams {
    cityName: string;
}

/**
 * Błędy domenowe dla generatora workflow
 */
export class N8nBuilderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'N8nBuilderError';
    }
}

/**
 * Protokół (interfejs) dla narzędzia budującego plik
 */
export interface N8nWorkflowBuilderProtocol {
    build(params: N8nWorkflowParams): object;
}

// --- Implementacja ---

export class N8nWorkflowBuilder implements N8nWorkflowBuilderProtocol {
    private templatePath: string;

    constructor(templatePath?: string) {
        // Domyślnie używamy szablonu w głównym katalogu
        this.templatePath = templatePath || path.resolve(process.cwd(), 'MM zbiórka newsów - Opole.json');
    }

    public build(params: N8nWorkflowParams): any {
        if (!params.cityName || params.cityName.trim() === '') {
            throw new N8nBuilderError('Nazwa miasta nie może być pusta');
        }

        const city = params.cityName.trim();

        if (!fs.existsSync(this.templatePath)) {
            throw new N8nBuilderError(`Plik szablonu nie istnieje: ${this.templatePath}`);
        }

        let templateJson: any;
        try {
            const fileContent = fs.readFileSync(this.templatePath, 'utf8');
            templateJson = JSON.parse(fileContent);
        } catch (e: any) {
            throw new N8nBuilderError(`Błąd odczytu lub parsowania pliku szablonu: ${e.message}`);
        }

        // 1. Zmiana nazwy workflow
        templateJson.name = `MM zbiórka newsów - ${city}`;

        // 2. Usunięcie meta info do wygenerowania na nowo przez n8n przy imporcie
        delete templateJson.id;
        if (templateJson.meta) {
            delete templateJson.meta.instanceId;
        }

        if (!Array.isArray(templateJson.nodes)) {
            throw new N8nBuilderError('Nieprawidłowy format pliku: brak nodes');
        }

        // 3. Wstrzyknięcie nazwy miasta do noda "Edit Fields"
        const editFieldsNode = templateJson.nodes.find((n: any) => n.name === 'Edit Fields');
        if (editFieldsNode && editFieldsNode.parameters?.assignments?.assignments) {
            const miastoAssignment = editFieldsNode.parameters.assignments.assignments.find((a: any) => a.name === 'Miasto');
            if (miastoAssignment) {
                miastoAssignment.value = `=${city}`;
            }
        }

        // 4. Usunięcie niechcianych węzłów związanych z HTTP na sztywno dla Opola
        const nodesToRemove = ['HTTP Request', 'HTML', 'Split Out3', 'Extract1', 'Filter1', 'Aggregate', 'Merge'];
        templateJson.nodes = templateJson.nodes.filter((n: any) => !nodesToRemove.includes(n.name));

        // 5. Zmiana i czyszczenie połączeń w grafie (connections)
        if (templateJson.connections) {
            // Łączymy Aggregate1 bezpośrednio z Redaktorem
            if (templateJson.connections['Aggregate1']?.main?.[0]) {
                const connList = templateJson.connections['Aggregate1'].main[0];
                const cleanList = connList.filter((c: any) => c.node !== 'Merge');
                cleanList.push({ node: 'Redaktor', type: 'main', index: 0 });
                templateJson.connections['Aggregate1'].main[0] = cleanList;
            }

            // Usunięcie połączenia z HTTP Request z głównego brancha (Edit Fields)
            if (templateJson.connections['Edit Fields']?.main?.[0]) {
                templateJson.connections['Edit Fields'].main[0] = templateJson.connections['Edit Fields'].main[0].filter(
                    (conn: any) => conn.node !== 'HTTP Request'
                );
            }

            // Usunięcie wpisów zdefiniowanych dla usuniętych węzłów z mapy connections
            for (const removed of nodesToRemove) {
                delete templateJson.connections[removed];
            }
        }

        return templateJson;
    }
}
