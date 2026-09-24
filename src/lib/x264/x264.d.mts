export type X264Module = {
  HEAPU8: Uint8Array
  stringToNewUTF8(s: string): number
  _malloc(size: number): number
  _free(ptr: number): void
  _enc_open(width: number, height: number, fpsNum: number, fpsDen: number, csp: number, options: number): number
  _enc_plane(enc: number, i: number): number
  _enc_stride(enc: number, i: number): number
  _enc_headers(enc: number): number
  _enc_headers_ptr(enc: number): number
  _enc_encode(enc: number, pts: number): number
  _enc_flush(enc: number): number
  _enc_payload(enc: number): number
  _enc_out_pts(enc: number): number
  _enc_out_keyframe(enc: number): number
  _enc_close(enc: number): void
  _enc_import_rgba(enc: number, rgba: number, stride: number, width: number, height: number, bgr: number): void
  _enc_import_p16(
    enc: number,
    y: number,
    u: number,
    v: number,
    sy: number,
    su: number,
    sv: number,
    width: number,
    height: number,
    bits: number,
  ): void
}

type Options = {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object
}

export default function createX264(options?: Options): Promise<X264Module>
