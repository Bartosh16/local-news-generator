export interface IHtmlFetcher {
  fetchHtml(url: string, timeoutMs?: number): Promise<string>;
}
