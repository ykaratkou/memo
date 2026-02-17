import { pipeline, type FeatureExtractionPipeline, env } from "@xenova/transformers";
import { resolve } from "node:path";

// Cache models locally in .models directory next to the project
env.cacheDir = resolve(import.meta.dirname, "..", ".models");
// Disable remote model checks after first download
env.allowLocalModels = true;

const MODEL_ID = "Xenova/nomic-embed-text-v1";

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  console.error("Loading embedding model (first run may download ~130MB)...");
  extractor = await pipeline("feature-extraction", MODEL_ID, {
    quantized: true,
  });
  console.error("Model loaded.");
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  // nomic-embed-text-v1 recommends prefixing queries with "search_query: "
  // and documents with "search_document: " but for simplicity we skip that here
  const output = await ext(text, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

export async function embedForSearch(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(`search_query: ${text}`, {
    pooling: "mean",
    normalize: true,
  });
  return output.data as Float32Array;
}

export async function embedForStorage(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(`search_document: ${text}`, {
    pooling: "mean",
    normalize: true,
  });
  return output.data as Float32Array;
}
