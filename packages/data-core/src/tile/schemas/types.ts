// Schema = how MVT properties translate to our LayerName enum + per-feature
// numbers. Each provider's schema implements this interface; the worker is
// otherwise schema-agnostic.

import type { LayerName } from "../types";

export interface SchemaFeatureProps {
  // MVT feature.properties as plain object.
  [k: string]: unknown;
}

export interface Schema {
  // Output LayerName → list of MVT source-layer names to consult, in order.
  aliases: Record<LayerName, readonly string[]>;
  // Output LayerName → required MVT geometry type (1=point, 2=line, 3=polygon).
  expectedType: Record<LayerName, 1 | 2 | 3>;
  // Decide which class enum (or null = drop) a feature maps to for the given
  // target layer. `sourceLayer` is the MVT layer this feature came from.
  classify(
    target: LayerName,
    sourceLayer: string,
    props: SchemaFeatureProps,
  ): number | null;
  // Per-feature height in metres (buildings only; return 0 to use fallbacks).
  heightFor(props: SchemaFeatureProps): number;
  minHeightFor(props: SchemaFeatureProps): number;
}
