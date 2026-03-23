import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;

/**
 * Generuje obrazek wyróżniający dla artykułu.
 * Template: tło miasta + ciemny gradient overlay + tekst.
 *
 * Kontrakt:
 * - Input: nazwa miasta, data, ścieżka output
 * - Output: ścieżka do wygenerowanego pliku JPEG
 * - Invariant: wymiary 1200x630px, format JPEG
 */
export async function generateFeaturedImage(
    city: string,
    date: Date,
    outputDir: string
): Promise<string> {
    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    const dateStr = date.toLocaleDateString('pl-PL', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });

    const filename = `${city.toLowerCase().replace(/\s+/g, '-')}_${date.toISOString().split('T')[0]}.jpg`;
    const outputPath = path.join(outputDir, filename);

    // Look for city background image
    const assetsDir = path.resolve(process.cwd(), 'assets', 'cities');
    const cityBg = path.join(assetsDir, `${city.toLowerCase().replace(/\s+/g, '-')}.jpg`);
    const defaultBg = path.join(assetsDir, 'default.jpg');

    let baseImage: sharp.Sharp;

    if (fs.existsSync(cityBg)) {
        baseImage = sharp(cityBg).resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover' });
    } else if (fs.existsSync(defaultBg)) {
        baseImage = sharp(defaultBg).resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover' });
    } else {
        // Create a gradient background if no image exists
        baseImage = sharp({
            create: {
                width: IMAGE_WIDTH,
                height: IMAGE_HEIGHT,
                channels: 4,
                background: { r: 30, g: 58, b: 95, alpha: 1 },
            },
        });
    }

    // Create dark gradient overlay
    const overlay = Buffer.from(
        `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:rgba(0,0,0,0.3)" />
          <stop offset="60%" style="stop-color:rgba(0,0,0,0.6)" />
          <stop offset="100%" style="stop-color:rgba(0,0,0,0.85)" />
        </linearGradient>
      </defs>
      <rect width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" fill="url(#grad)" />
      <text x="60" y="${IMAGE_HEIGHT - 120}" 
            font-family="Arial, Helvetica, sans-serif" 
            font-size="48" font-weight="bold" fill="white">
        Wiadomości z ${escapeXml(city)}
      </text>
      <text x="60" y="${IMAGE_HEIGHT - 60}" 
            font-family="Arial, Helvetica, sans-serif" 
            font-size="28" fill="rgba(255,255,255,0.8)">
        ${escapeXml(dateStr)}
      </text>
    </svg>`
    );

    await baseImage
        .composite([{ input: overlay, top: 0, left: 0 }])
        .jpeg({ quality: 85 })
        .toFile(outputPath);

    return outputPath;
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
