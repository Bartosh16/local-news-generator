import { CrawlerSelectorService } from './crawler-selector.service';
import { FetchHtmlFetcher } from './adapters/fetch-html-fetcher';
import { DomAnalyzer } from './domain/dom-analyzer';

export * from './domain/dto';
export * from './domain/port';
export * from './domain/errors';

export function createCrawlerSelectorService(): CrawlerSelectorService {
  return new CrawlerSelectorService(
    new FetchHtmlFetcher(),
    new DomAnalyzer()
  );
}
