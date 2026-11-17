/* tslint:disable */
/* eslint-disable */

export function decode(input: string): string;

export function encode(input: string, secret: string): string;

export function encode_ai_prompt(input: string, ai_type: number, base_prompt: string, system_message: string, metadata: string): string;

export function encode_reference(input: string, reference_type: number, reference_id: string, metadata: string): string;

export function encode_secure_note(input: string, note_id: string, password: string, metadata: string): string;

/**
 * Strict structured decode of every envelope in `input`, as JSON.
 */
export function inspect(input: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly decode: (a: number, b: number) => [number, number, number, number];
  readonly encode: (a: number, b: number, c: number, d: number) => [number, number];
  readonly encode_ai_prompt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
  readonly encode_reference: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
  readonly encode_secure_note: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
  readonly inspect: (a: number, b: number) => [number, number];
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
