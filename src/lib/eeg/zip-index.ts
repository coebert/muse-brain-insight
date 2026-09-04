/**
 * Minimal ZIP central-directory reader.
 *
 * Some published archives are far too large to download whole — DOSE-I's raw
 * `data.zip` is 724 MB — but each member inside them is a few megabytes. A ZIP
 * keeps its index at the end of the file, so reading the tail is enough to
 * learn where every member starts, after which a single byte range fetches one
 * recording without touching the rest of the archive.
 *
 * Only the two cases that actually occur in these records are handled: stored
 * (method 0) and deflate (method 8). Zip64 archives are rejected rather than
 * mis-read.
 */

export interface ZipMember {
  name: string;
  /** Offset of the member's local file header within the archive. */
  headerOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. */
  method: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u16(v: DataView, at: number) {
  return v.getUint16(at, true);
}
function u32(v: DataView, at: number) {
  return v.getUint32(at, true);
}

/**
 * Read the member index from the tail of an archive.
 *
 * @param tail the last bytes of the file; must reach back past the whole
 *   central directory
 * @param tailStart byte offset of `tail[0]` within the archive
 */
export function readZipIndex(tail: Uint8Array, tailStart: number): ZipMember[] {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(view, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No ZIP end-of-directory record in the fetched tail.");

  const count = u16(view, eocd + 10);
  const dirSize = u32(view, eocd + 12);
  const dirOffset = u32(view, eocd + 16);
  if (dirOffset === 0xffffffff || dirSize === 0xffffffff || count === 0xffff) {
    throw new Error("Zip64 archives are not supported by this reader.");
  }

  let p = dirOffset - tailStart;
  if (p < 0) throw new Error("The fetched tail does not reach the ZIP central directory.");

  const members: ZipMember[] = [];
  const decoder = new TextDecoder();
  while (p + 46 <= tail.byteLength && u32(view, p) === SIG_CENTRAL) {
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const uncompressedSize = u32(view, p + 24);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const headerOffset = u32(view, p + 42);
    const name = decoder.decode(tail.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith("/")) {
      members.push({ name, headerOffset, compressedSize, uncompressedSize, method });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

/**
 * Strip a member's local file header from a byte range that starts at
 * `member.headerOffset`, returning just the compressed payload.
 */
export function zipMemberPayload(member: ZipMember, bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 30 || u32(view, 0) !== SIG_LOCAL) {
    throw new Error(`Member ${member.name} does not start with a local file header.`);
  }
  const nameLen = u16(view, 26);
  const extraLen = u16(view, 28);
  const start = 30 + nameLen + extraLen;
  return bytes.subarray(start, start + member.compressedSize);
}

/** How many bytes to fetch for a member, header and payload together. */
export function zipMemberByteRange(member: ZipMember): { start: number; end: number } {
  // 30-byte header plus name and extra fields; 4 KB covers any realistic name.
  return {
    start: member.headerOffset,
    end: member.headerOffset + member.compressedSize + 4096,
  };
}

/** Inflate (or pass through) one member's payload as text. */
export async function zipMemberText(member: ZipMember, bytes: Uint8Array): Promise<string> {
  const payload = zipMemberPayload(member, bytes);
  if (member.method === 0) return new TextDecoder().decode(payload);
  if (member.method !== 8) throw new Error(`Unsupported ZIP compression method ${member.method}.`);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(payload as unknown as BufferSource);
      controller.close();
    },
  });
  const stream = source.pipeThrough<Uint8Array>(new DecompressionStream("deflate-raw"));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
}
