export type VmafModule = {
  HEAPU8: Uint8Array
  /** A scorer for frames of this size, loaded with the VMAF NEG model. */
  _score_open(width: number, height: number): number
  /** Staging planes for the next pair's luma, width × height bytes each. */
  _score_ref(scorer: number): number
  _score_dist(scorer: number): number
  /** Scores the staged pair; nonzero on failure. */
  _score_add(scorer: number): number
  /** Mean VMAF NEG over the pairs from `first` on, or -1. */
  _score_finish(scorer: number, first: number): number
  _score_close(scorer: number): void
}

type Options = {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object
}

export default function createVmaf(options?: Options): Promise<VmafModule>
