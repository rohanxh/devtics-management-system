import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { invalid } from './errors.ts';

/** Allowed upload types. SVG/HTML are excluded on purpose (stored-XSS vectors). */
const ALLOWED: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

/** Magic-byte signatures for types browsers may render inline. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

export function resolveType(filename: string) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mime = ALLOWED[ext];
  if (!mime) throw invalid('Validation failed', { file: `File type .${ext || '?'} is not allowed` });
  return { ext, mime };
}

export class Storage {
  root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key.split('/').pop() ?? '') || key.includes('..')) throw new Error('Invalid storage key');
    return path.join(this.root, key);
  }

  /** Streams an upload to disk under a random key; returns size + sha256. Verifies magic bytes. */
  async save(stream: Readable, filename: string) {
    const { ext, mime } = resolveType(filename);
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const target = this.pathFor(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        cb(null, chunk);
      },
    });
    await pipeline(stream, tap, fs.createWriteStream(target, { flags: 'wx' }));
    if ((stream as any).truncated) {
      await fs.promises.rm(target, { force: true });
      throw invalid('Validation failed', { file: 'File is too large (max 25 MB)' });
    }
    if (size === 0 || (MAGIC[ext] && !MAGIC[ext](head))) {
      await fs.promises.rm(target, { force: true });
      throw invalid('Validation failed', { file: 'File content does not match its type' });
    }
    return { key, size, sha256: hash.digest('hex'), mime };
  }

  open(key: string) {
    return fs.createReadStream(this.pathFor(key));
  }

  async remove(key: string) {
    await fs.promises.rm(this.pathFor(key), { force: true });
  }
}
