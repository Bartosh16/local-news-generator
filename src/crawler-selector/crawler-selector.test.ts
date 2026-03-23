import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { ExtractNewsSelectorCommand } from './domain/dto';
import { InvalidUrlError, NetworkFetchError, SelectorExtractionFailedError } from './domain/errors';
import { ICrawlerSelectorService } from './domain/port';

// W środowisku testowym mockujemy serwis implementujący ICrawlerSelectorService
class MockCrawlerSelectorService implements ICrawlerSelectorService {
  async extractNewsList(command: ExtractNewsSelectorCommand) {
    if (!command.url.startsWith('http')) {
      throw new InvalidUrlError('Invalid URL format');
    }
    if (command.url === 'http://network-error.com') {
      throw new NetworkFetchError('Connection failed');
    }
    if (command.url === 'http://no-news.com') {
      throw new SelectorExtractionFailedError('Could not find news selector');
    }

    // Happy path mock
    return {
      cssSelector: '.news-item a.title',
      newsUrls: [
        'http://example.com/news/1',
        'http://example.com/news/2'
      ]
    };
  }
}

describe('Crawler Selector - Contract Tests', () => {
  const service: ICrawlerSelectorService = new MockCrawlerSelectorService();

  it('powinien zwracac poprawne DTO dla dobrego urla', async () => {
    const result = await service.extractNewsList({ url: 'http://example.com/news-category' });
    
    assert.ok(result.cssSelector.length > 0, 'CSS Selector is present');
    assert.ok(result.newsUrls.length > 0, 'News URLs are present');
    assert.strictEqual(result.newsUrls[0], 'http://example.com/news/1');
  });

  it('powinien rzucac InvalidUrlError dla niepoprawnego URL-a', async () => {
    await assert.rejects(
      () => service.extractNewsList({ url: 'not-a-url' }),
      (err: Error) => err instanceof InvalidUrlError
    );
  });

  it('powinien rzucac NetworkFetchError gdy problem z siecia', async () => {
    await assert.rejects(
      () => service.extractNewsList({ url: 'http://network-error.com' }),
      (err: Error) => err instanceof NetworkFetchError
    );
  });

  it('powinien rzucac SelectorExtractionFailedError gdy struktura jest nietypowa', async () => {
    await assert.rejects(
      () => service.extractNewsList({ url: 'http://no-news.com' }),
      (err: Error) => err instanceof SelectorExtractionFailedError
    );
  });
});
