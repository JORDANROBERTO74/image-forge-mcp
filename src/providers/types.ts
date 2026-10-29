export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  strength?: number;
  width: number;
  height: number;
  steps: number;
  seed?: number;
}

export interface ImageToImageRequest extends ImageGenRequest {
  image: Buffer;
  imageMime: string;
}

export interface ProviderResult {
  buffer: Buffer;
  mime: string;
  model: string;
  seed?: number;
  estimatedNeurons: number;
  notes: string[];
}
