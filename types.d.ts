// Global type declarations for Node.js built-in modules

declare module 'fs' {
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readFileSync(path: string): Buffer;
  export function existsSync(path: string): boolean;
  export function writeFileSync(
    path: string,
    data: string | Buffer,
    encoding?: BufferEncoding
  ): void;
  export function unlinkSync(path: string): void;
}

declare module 'path' {
  export function resolve(...paths: string[]): string;
}

// Console and setTimeout are global
declare var console: {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

declare function setTimeout(callback: () => void, ms: number): any;

type BufferEncoding =
  | 'ascii'
  | 'utf8'
  | 'utf-8'
  | 'utf16le'
  | 'ucs2'
  | 'ucs-2'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'binary'
  | 'hex';

interface Buffer {}
