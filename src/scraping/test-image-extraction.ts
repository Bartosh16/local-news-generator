import assert from 'assert';
import { extractImageUrl } from './scraper.js';

async function runTests() {
    const baseUrl = 'https://example.com/article';

    // 1. Wyciągnięcie z og:image (priorytet)
    {
        const html = `
            <html>
                <head><meta property="og:image" content="https://example.com/og-image.jpg" /></head>
                <body><article><img src="/article-img.jpg" /></article></body>
            </html>
        `;
        const res = extractImageUrl(html, baseUrl);
        assert.strictEqual(res, 'https://example.com/og-image.jpg');
    }

    // 2. Fallback do pierwszego obrazka w <article> gdy brak og:image, url rozwiązywany relatywnie
    {
        const html = `
            <html>
                <head></head>
                <body><article><img src="/article-img.jpg" /></article></body>
            </html>
        `;
        const res = extractImageUrl(html, baseUrl);
        assert.strictEqual(res, 'https://example.com/article-img.jpg');
    }

    // 3. Fallback do jakiegokolwiek obrazka, gdy article jest pusty
    {
        const html = `
            <html>
                <head></head>
                <body><img src="https://example.com/header.png" /><article></article></body>
            </html>
        `;
        const res = extractImageUrl(html, baseUrl);
        assert.strictEqual(res, 'https://example.com/header.png');
    }

    // 4. Ignorowanie niechcianych obrazków (base64, SVG)
    {
        const html = `
            <html>
                <body>
                    <article>
                        <meta property="og:image" content="data:image/png;base64,iVBORw0KGgo" />
                        <img src="/icon.svg" />
                        <img src="/real.jpg" />
                    </article>
                </body>
            </html>
        `;
        const res = extractImageUrl(html, baseUrl);
        assert.strictEqual(res, 'https://example.com/real.jpg');
    }

    // 5. Zwracanie undefined gdy zaden obrazek nie pasuje
    {
        const html = `<html><body><article>Just text</article></body></html>`;
        const res = extractImageUrl(html, baseUrl);
        assert.strictEqual(res, undefined);
    }

    console.log('Testy kontraktowe extractImageUrl przeszły pomyślnie!');
}

runTests().catch(console.error);
