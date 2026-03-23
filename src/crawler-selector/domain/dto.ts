export interface ExtractNewsSelectorCommand {
  url: string;
  timeoutMs?: number;
}

export interface NewsSelectorResult {
  /** Unikalny selektor CSS obejmujący kontener z linkiem do newsa */
  cssSelector: string; 
  /** Lista wciągniętych, przefiltrowanych URL-i dla artykułów */
  newsUrls: string[]; 
}
