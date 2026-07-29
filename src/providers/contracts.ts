export interface TextProvider {
  generateJson(input: {
    system: string;
    payload: unknown;
    schemaName: string;
  }): Promise<unknown>;
}

export type GeneratedImage =
  | { kind: "base64"; data: string; mimeType: "image/png" | "image/jpeg" }
  | { kind: "url"; url: string };

export interface ImageProvider {
  generate(input: { prompt: string; size: "1792x1024" }): Promise<GeneratedImage>;
}

export interface ReviewProvider {
  review(input: {
    system: string;
    screenshotDataUrl: string;
    payload: unknown;
  }): Promise<unknown>;
}

export interface ProviderBundle {
  text: TextProvider;
  image: ImageProvider;
  review: ReviewProvider;
}
