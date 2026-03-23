export abstract class CrawlerDomainError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class NetworkFetchError extends CrawlerDomainError {
  constructor(message: string) { super(message, 'NETWORK_FETCH_FAILED'); }
}

export class InvalidUrlError extends CrawlerDomainError {
  constructor(message: string) { super(message, 'INVALID_URL'); }
}

export class SelectorExtractionFailedError extends CrawlerDomainError {
  constructor(message: string) { super(message, 'SELECTOR_EXTRACTION_FAILED'); }
}
