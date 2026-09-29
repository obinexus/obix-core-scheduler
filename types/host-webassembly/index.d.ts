/**
 * The part of the WebAssembly JS API the language-binding type layers reference.
 * Separate from `host-globals` because @types/node does not declare WebAssembly while the DOM lib does:
 * packages list `host-webassembly` only when they reference it and neither the DOM lib nor a lib that provides it is enabled.
 */
declare namespace WebAssembly {
  interface MemoryDescriptor { initial: number; maximum?: number; shared?: boolean }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
}
