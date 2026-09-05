import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { log } from "../logger.js";

/**
 * Local CPU embeddings via Transformers.js (onnxruntime-node).
 *
 * The default model is an e5 variant, which is trained with asymmetric
 * prefixes: documents must be embedded as `passage: ...`, queries as
 * `query: ...`. Mixing them up measurably degrades retrieval quality.
 */

export interface EmbedderOptions {
  modelId: string;
  cacheDir: string;
  allowRemoteModels: boolean;
  batchSize?: number;
}

export class Embedder {
  private pipe: FeatureExtractionPipeline | undefined;
  private dimension: number | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly options: EmbedderOptions) {}

  get modelId(): string {
    return this.options.modelId;
  }

  /** Dimension of the produced vectors; only known after the first embedding. */
  get dim(): number | undefined {
    return this.dimension;
  }

  get isLoaded(): boolean {
    return this.pipe !== undefined;
  }

  async load(): Promise<void> {
    if (this.pipe) return;
    if (!this.loading) {
      this.loading = this.doLoad().catch((error) => {
        this.loading = undefined;
        throw error;
      });
    }
    await this.loading;
  }

  private async doLoad(): Promise<void> {
    env.cacheDir = this.options.cacheDir;
    env.localModelPath = this.options.cacheDir;
    env.allowRemoteModels = this.options.allowRemoteModels;

    const started = Date.now();
    log.info("loading embedding model", { model: this.options.modelId, cacheDir: this.options.cacheDir });
    this.pipe = await pipeline("feature-extraction", this.options.modelId, { dtype: "q8" });
    log.info("embedding model ready", { ms: Date.now() - started });
  }

  /** Embed documents. Returns one unit-length vector per input. */
  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((text) => `passage: ${text}`));
  }

  /** Embed a search query. */
  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([`query: ${text}`]);
    return vector;
  }

  private async embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    await this.load();
    const pipe = this.pipe;
    if (!pipe) throw new Error("Embedding pipeline is not initialised.");

    const batchSize = this.options.batchSize ?? 16;
    const out: Float32Array[] = [];

    for (let offset = 0; offset < inputs.length; offset += batchSize) {
      const batch = inputs.slice(offset, offset + batchSize);
      const tensor = await pipe(batch, { pooling: "mean", normalize: true });
      const rows = tensor.tolist() as number[][];
      for (const row of rows) {
        if (this.dimension === undefined) this.dimension = row.length;
        else if (row.length !== this.dimension) {
          throw new Error(`Model returned inconsistent dimensions (${row.length} vs ${this.dimension}).`);
        }
        out.push(Float32Array.from(row));
      }
    }

    return out;
  }
}
