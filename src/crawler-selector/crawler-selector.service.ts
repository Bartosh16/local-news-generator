import { ExtractNewsSelectorCommand, NewsSelectorResult } from './domain/dto';
import { ICrawlerSelectorService } from './domain/port';
import { InvalidUrlError } from './domain/errors';
import { IHtmlFetcher } from './domain/ports/html-fetcher.port';
import { DomAnalyzer } from './domain/dom-analyzer';

export class CrawlerSelectorService implements ICrawlerSelectorService {
  constructor(
    private readonly htmlFetcher: IHtmlFetcher,
    private readonly domAnalyzer: DomAnalyzer
  ) {}

  async extractNewsList(command: ExtractNewsSelectorCommand): Promise<NewsSelectorResult> {
    if (!command.url || !command.url.startsWith('http')) {
      throw new InvalidUrlError('Podany URL ma niepoprawny format.');
    }

    const html = await this.htmlFetcher.fetchHtml(command.url, command.timeoutMs);
    const result = this.domAnalyzer.analyze(html, command.url);

    return {
      cssSelector: result.selector,
      newsUrls: result.urls
    };
  }
}
