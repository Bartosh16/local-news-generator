import { ExtractNewsSelectorCommand, NewsSelectorResult } from './dto';

export interface ICrawlerSelectorService {
  /**
   * Wykrywa selektor newsów oraz wyciąga ich listę linków z danej strony
   * @throws {NetworkFetchError} gdy strona jest nieosiągalna
   * @throws {InvalidUrlError} dla błędnego formatu
   * @throws {SelectorExtractionFailedError} jeśli nie udało się znaleźć selektora
   */
  extractNewsList(command: ExtractNewsSelectorCommand): Promise<NewsSelectorResult>;
}
