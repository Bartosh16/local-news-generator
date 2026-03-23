import { IHtmlFetcher } from '../domain/ports/html-fetcher.port';
import { NetworkFetchError } from '../domain/errors';

export class FetchHtmlFetcher implements IHtmlFetcher {
  async fetchHtml(url: string, timeoutMs: number = 10000): Promise<string> {
    // Próba 1: zwykły fetch (szybki)
    try {
      const html = await this.fetchWithHttp(url, timeoutMs);
      return html;
    } catch {
      // ignoruj, próbujemy Puppeteer
    }

    // Próba 2: Puppeteer z stealth (dla stron blokujących boty)
    return this.fetchWithPuppeteer(url, timeoutMs);
  }

  private async fetchWithHttp(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchWithPuppeteer(url: string, timeoutMs: number): Promise<string> {
    let browser;
    try {
      const puppeteerExtra = await import('puppeteer-extra') as any;
      const StealthPlugin = await import('puppeteer-extra-plugin-stealth') as any;
      const puppeteer = puppeteerExtra.default ?? puppeteerExtra;
      puppeteer.use((StealthPlugin.default ?? StealthPlugin)());

      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setDefaultNavigationTimeout(timeoutMs);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const html = await page.content();
      return html;
    } catch (error: any) {
      throw new NetworkFetchError(error.message || 'Puppeteer fetch failed');
    } finally {
      if (browser) await browser.close();
    }
  }
}
