import type { SourceNormalizerAdapter } from "./types";
import { ShopifyAdapter } from "./adapters/shopify.adapter";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { BankAdapter } from "./adapters/bank.adapter";
import { GenericCodAdapter } from "./adapters/generic-cod.adapter";
import { AmazonAdapter } from "./adapters/amazon.adapter";

export class NormalizerRegistry {
  private adapters = new Map<string, SourceNormalizerAdapter>();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers default built-in adapters.
   */
  private registerDefaults(): void {
    this.register(new ShopifyAdapter());
    this.register(new RazorpayAdapter());
    this.register(new BankAdapter());
    this.register(new AmazonAdapter());

    const genericCod = new GenericCodAdapter();
    this.register(genericCod);
    // Alias courier_settlement to GenericCodAdapter
    this.registerAlias("courier_settlement", genericCod);
  }

  /**
   * Register a new or custom adapter.
   */
  public register(adapter: SourceNormalizerAdapter): void {
    this.adapters.set(adapter.detectedSource, adapter);
  }

  /**
   * Register an alias source key pointing to an existing adapter instance.
   */
  public registerAlias(alias: string, adapter: SourceNormalizerAdapter): void {
    this.adapters.set(alias, adapter);
  }

  /**
   * Look up an adapter by detectedSource string.
   */
  public get(detectedSource: string): SourceNormalizerAdapter | undefined {
    return this.adapters.get(detectedSource);
  }

  /**
   * Get all registered adapter instances (unique by reference).
   */
  public getAll(): SourceNormalizerAdapter[] {
    return Array.from(new Set(this.adapters.values()));
  }

  /**
   * Get all unique adapters sorted in execution priority order.
   */
  public getSortedAdapters(): SourceNormalizerAdapter[] {
    return this.getAll().sort((a, b) => a.priority - b.priority);
  }
}

// Global singleton instance for the app
export const normalizerRegistry = new NormalizerRegistry();
