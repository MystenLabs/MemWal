import { ChatbotError } from "@/lib/errors";

/**
 * Decompression-bomb guard for uploaded PDFs (WALM-683).
 *
 * A PDF stores page content, fonts and object streams Flate-compressed, and
 * deflate reaches about 1030:1 — a 1MB upload can hold a stream that expands to
 * a gigabyte. pdf.js inflates a stream in full, doubling its buffer with no
 * ceiling, before returning a single character, so no byte, page or character
 * cap downstream ever sees it: one upload takes the replica down.
 *
 * JavaScript cannot put a memory ceiling around pdf.js, so this measures instead:
 * before pdf.js sees the file, every stream pdf.js could inflate is inflated
 * here with the output counted and discarded, and the file is refused if a
 * stream or the whole file would expand past the budget.
 *
 * The guard only works if it sees each stream exactly as pdf.js does, so every
 * rule below mirrors pdf.js (unpdf's bundled build) rather than the spec, and
 * anything this cannot read the way pdf.js reads it is refused:
 *
 *   - The file is tokenised the way pdf.js's Lexer does — literal and hex
 *     strings, `%` comments, `#xx` escapes in names — so a `/Filter` inside a
 *     string or comment is not a filter, and `/#46ilter` is. A repeated key keeps
 *     its last value, as in pdf.js.
 *   - The filter is `/F` if present, else `/Filter`; parameters are `/DP`, else
 *     `/DecodeParms` (`Parser.filter`: `dict.get("F", "Filter")`).
 *   - Every `N G obj` header and every `>> stream` in the raw bytes — inside
 *     strings, comments and other streams' data included — must be one this
 *     tokeniser parsed as such. pdf.js can reach an object from an xref offset
 *     or from recovery's raw scan, so a header or stream hidden where a parser
 *     would not look is refused rather than left unmeasured.
 *   - pdf.js parses object streams with `allowStreams: true`, and takes any
 *     stream with `/First` and `/N` as one. Such a stream is decoded here and
 *     refused if it contains a stream, which the spec forbids and which this
 *     byte scan could not otherwise see.
 *   - At most one expanding filter (Flate or RunLength), and only first. LZW
 *     is refused. Filters and predictor parameters must be direct values.
 *   - Flate is measured with a port of pdf.js's own inflater (see PdfjsFlate),
 *     not Node's zlib, which disagrees with it on window size and bad
 *     back-references. It checks the same header bits pdf.js does (method,
 *     FCHECK, FDICT, not CINFO) and stops exactly where pdf.js stops, so there
 *     is no "unmeasured" case left: the count is what pdf.js would allocate.
 *   - PNG/TIFF predictors allocate a row of Columns × Colors × BPC bits whatever
 *     the stream holds; a row over the per-stream budget is refused.
 *   - Encrypted files are refused: their stream bytes are ciphertext and cannot
 *     be measured. (Product decision, confirmed on #985.)
 *
 * Budgets: 64MB per stream, 256MB per file, 20,000 streams — confirmed on #985,
 * tunable per environment.
 */

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Largest decompressed size accepted for any single stream. */
export const MAX_INFLATED_BYTES_PER_STREAM = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_INFLATED_BYTES_PER_STREAM",
  64 * 1024 * 1024
);

/** Largest decompressed size accepted across every stream in the file. */
export const MAX_INFLATED_BYTES_TOTAL = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_INFLATED_BYTES_TOTAL",
  256 * 1024 * 1024
);

/** Streams in one file. Bounds the scan's own work on a file of tiny streams. */
export const MAX_PDF_STREAMS = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_STREAMS",
  20_000
);

export type PdfGuardLimits = {
  perStream: number;
  total: number;
  streams: number;
};

const DEFAULT_LIMITS: PdfGuardLimits = {
  perStream: MAX_INFLATED_BYTES_PER_STREAM,
  total: MAX_INFLATED_BYTES_TOTAL,
  streams: MAX_PDF_STREAMS,
};

function refuse(reason: string): ChatbotError {
  return new ChatbotError("bad_request:api", reason);
}

const CANNOT_CHECK = "PDF has a structure this service cannot check safely";

/** A structural refusal, with which rule fired — for support, not for users to act on. */
function cannotCheck(detail: string): ChatbotError {
  return refuse(`${CANNOT_CHECK} (${detail})`);
}

// ── tokeniser ─────────────────────────────────────────────────────────────

/** pdf.js whitespace: NUL, TAB, LF, FF, CR, SP. */
function isWhitespace(byte: number): boolean {
  return (
    byte === 0x00 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

/** pdf.js delimiters: ( ) < > [ ] { } / % */
function isDelimiter(byte: number): boolean {
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  );
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

type Token =
  | { kind: "number"; value: number; integer: boolean; start: number }
  | { kind: "name"; value: string; start: number }
  | { kind: "string"; start: number }
  | { kind: "dictOpen" | "dictClose" | "arrayOpen" | "arrayClose"; start: number }
  | { kind: "keyword"; value: string; start: number; end: number }
  | { kind: "eof"; start: number };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

class Lexer {
  pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    private readonly end: number
  ) {
    this.pos = start;
  }

  next(): Token {
    const { bytes, end } = this;

    for (;;) {
      while (this.pos < end && isWhitespace(bytes[this.pos])) this.pos++;
      if (this.pos < end && bytes[this.pos] === 0x25) {
        while (this.pos < end && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d) {
          this.pos++;
        }
        continue;
      }
      break;
    }

    const start = this.pos;
    if (start >= end) return { kind: "eof", start };
    const byte = bytes[start];

    if (byte === 0x28) return this.literalString(start);
    if (byte === 0x3c) {
      if (bytes[start + 1] === 0x3c) {
        this.pos += 2;
        return { kind: "dictOpen", start };
      }
      return this.hexString(start);
    }
    if (byte === 0x3e) {
      if (bytes[start + 1] !== 0x3e) throw cannotCheck(`lone ">" at ${start}`);
      this.pos += 2;
      return { kind: "dictClose", start };
    }
    if (byte === 0x5b) {
      this.pos++;
      return { kind: "arrayOpen", start };
    }
    if (byte === 0x5d) {
      this.pos++;
      return { kind: "arrayClose", start };
    }
    if (byte === 0x2f) return this.name(start);
    if (!isRegular(byte)) throw cannotCheck(`unexpected "${String.fromCharCode(byte)}" at ${start}`); // ) { }

    while (this.pos < end && isRegular(bytes[this.pos])) this.pos++;
    const text = latin1(bytes.subarray(start, this.pos));
    if (/^[+\-.\d]/.test(text)) {
      if (!NUMBER.test(text)) throw cannotCheck(`malformed number "${text}" at ${start}`);
      return {
        kind: "number",
        value: Number(text),
        integer: !text.includes("."),
        start,
      };
    }
    return { kind: "keyword", value: text, start, end: this.pos };
  }

  private literalString(start: number): Token {
    const { bytes, end } = this;
    let depth = 0;
    while (this.pos < end) {
      const byte = bytes[this.pos++];
      if (byte === 0x5c) {
        this.pos++; // the escaped byte cannot open or close anything
      } else if (byte === 0x28) {
        depth++;
      } else if (byte === 0x29 && --depth === 0) {
        return { kind: "string", start };
      }
    }
    throw cannotCheck(`unterminated string at ${start}`);
  }

  private hexString(start: number): Token {
    const { bytes, end } = this;
    this.pos++;
    while (this.pos < end && bytes[this.pos] !== 0x3e) {
      const byte = bytes[this.pos++];
      if (hexValue(byte) === -1 && !isWhitespace(byte)) throw cannotCheck(`bad hex string at ${start}`);
    }
    if (this.pos >= end) throw cannotCheck(`unterminated hex string at ${start}`);
    this.pos++;
    return { kind: "string", start };
  }

  /** `#xx` is decoded as pdf.js's `getName` does; a malformed escape is refused. */
  private name(start: number): Token {
    const { bytes, end } = this;
    this.pos++;
    let value = "";
    while (this.pos < end && isRegular(bytes[this.pos])) {
      const byte = bytes[this.pos++];
      if (byte === 0x23) {
        const high = this.pos < end ? hexValue(bytes[this.pos]) : -1;
        const low = this.pos + 1 < end ? hexValue(bytes[this.pos + 1]) : -1;
        if (high === -1 || low === -1) throw cannotCheck(`bad #xx escape at ${start}`);
        value += String.fromCharCode((high << 4) | low);
        this.pos += 2;
      } else {
        value += String.fromCharCode(byte);
      }
    }
    return { kind: "name", value, start };
  }
}

// ── values ────────────────────────────────────────────────────────────────

type PdfValue =
  | { kind: "number"; value: number; integer: boolean }
  | { kind: "name"; value: string }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "ref"; num: number; gen: number }
  | { kind: "array"; items: PdfValue[] }
  | { kind: "dict"; entries: Map<string, PdfValue> };

const MAX_NESTING = 64;

class Parser {
  private readonly lookahead: Token[] = [];

  constructor(readonly lexer: Lexer) {}

  next(): Token {
    return this.lookahead.shift() ?? this.lexer.next();
  }

  /** Drop read-ahead tokens after the lexer has been moved. */
  reset(): void {
    this.lookahead.length = 0;
  }

  /** True when tokens past the last one returned have already been read. */
  hasLookahead(): boolean {
    return this.lookahead.length > 0;
  }

  peek(offset = 0): Token {
    while (this.lookahead.length <= offset) this.lookahead.push(this.lexer.next());
    return this.lookahead[offset];
  }

  value(depth = 0): PdfValue {
    if (depth > MAX_NESTING) throw cannotCheck("nesting too deep");
    const token = this.next();

    switch (token.kind) {
      case "number": {
        const gen = this.peek(0);
        const r = this.peek(1);
        if (
          token.integer &&
          gen.kind === "number" &&
          gen.integer &&
          r.kind === "keyword" &&
          r.value === "R"
        ) {
          this.next();
          this.next();
          return { kind: "ref", num: token.value, gen: gen.value };
        }
        return { kind: "number", value: token.value, integer: token.integer };
      }
      case "name":
        return { kind: "name", value: token.value };
      case "string":
        return { kind: "string" };
      case "arrayOpen": {
        const items: PdfValue[] = [];
        while (this.peek().kind !== "arrayClose") {
          if (this.peek().kind === "eof") throw cannotCheck("unterminated array");
          items.push(this.value(depth + 1));
        }
        this.next();
        return { kind: "array", items };
      }
      case "dictOpen": {
        const entries = new Map<string, PdfValue>();
        for (;;) {
          const key = this.next();
          if (key.kind === "dictClose") break;
          if (key.kind === "eof") throw cannotCheck("unterminated dictionary");
          if (key.kind !== "name") {
            // pdf.js: "Malformed dictionary: key must be a name object" — it
            // drops that one token and reads on, so this does the same.
            continue;
          }
          if (key.value === "Encrypt") {
            throw refuse(
              "Encrypted PDFs cannot be processed. Remove the protection and upload it again."
            );
          }
          // A repeated key keeps its last value, as pdf.js's Dict.set does (real
          // pdfTeX output repeats /Group). Reading it the same way pdf.js does is
          // what matters; refusing it rejected legitimate files.
          entries.set(key.value, this.value(depth + 1));
        }
        return { kind: "dict", entries };
      }
      case "keyword":
        if (token.value === "true" || token.value === "false") return { kind: "boolean" };
        if (token.value === "null") return { kind: "null" };
        throw cannotCheck(`unexpected keyword "${token.value}" at ${token.start}`);
      default:
        throw cannotCheck(`unexpected ${token.kind} at ${token.start}`);
    }
  }
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

// ── file structure ────────────────────────────────────────────────────────

type ParsedStream = {
  dict: Map<string, PdfValue>;
  /** Offset of the `stream` keyword. */
  keywordAt: number;
  /** First byte of data, after the end-of-line that follows the keyword. */
  dataStart: number;
  /**
   * Where pdf.js's data ends, when it can be known: from a direct `/Length`, or
   * from its own endstream search. Undefined when `/Length` is a reference —
   * then measuring runs until the compressed data itself ends.
   */
  dataEnd: number | undefined;
};

const EOF_MARKER = Buffer.from("%%EOF", "latin1");
const ENDSTREAM_KEYWORD = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"

/** Past whitespace and `%` comments from `pos`, as pdf.js's lexer skips them. */
function skipGap(bytes: Uint8Array, pos: number): number {
  while (pos < bytes.length) {
    const byte = bytes[pos];
    if (isWhitespace(byte)) {
      pos++;
    } else if (byte === 0x25) {
      while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
    } else {
      break;
    }
  }
  return pos;
}
const END = [0x65, 0x6e, 0x64]; // "end"
const ENDSTREAM_TAILS = [
  [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d], // "stream"
  [0x73, 0x74, 0x65, 0x61, 0x6d], //       "steam", then whitespace
  [0x73, 0x74, 0x72, 0x65, 0x61], //       "strea", then whitespace
];

/** pdf.js `Lexer.skipToNextLine`, from the byte after the `stream` keyword. */
function skipToNextLine(bytes: Uint8Array, pos: number): number {
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    if (byte === 0x0d) {
      if (bytes[pos] === 0x0a) pos++;
      return pos;
    }
    if (byte === 0x0a) return pos;
  }
  return pos;
}

/**
 * pdf.js's fallback endstream search (Parser `#findStreamLength`): the first
 * `end` followed by `stream`, or by `steam` / `strea` and whitespace — it
 * tolerates those typos. Returns the offset of `end`, or -1.
 */
function pdfjsFindStreamEnd(bytes: Uint8Array, from: number): number {
  const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
  for (let i = from; i + 9 <= bytes.length; i++) {
    if (!startsWith(bytes, i, END)) continue;
    const [full, ...typos] = ENDSTREAM_TAILS;
    if (startsWith(bytes, i + 3, full)) return i;
    for (const tail of typos) {
      if (startsWith(bytes, i + 3, tail) && isSpace(bytes[i + 3 + tail.length])) return i;
    }
  }
  return -1;
}

/**
 * Where pdf.js's stream data ends (`Parser.makeStream`): it jumps to
 * `start + /Length` and takes that if the next token is `endstream`; otherwise
 * — a bad or missing length, which it reads as 0 — it searches. A `/Length`
 * given by reference leaves the end unknown (see below).
 */
function streamRegion(
  bytes: Uint8Array,
  dict: Map<string, PdfValue>,
  dataStart: number
): { dataEnd: number | undefined; resumeAt: number } {
  const lengthValue = dict.get("Length");
  let length: number | undefined = 0;
  if (lengthValue?.kind === "number" && lengthValue.integer) {
    length = lengthValue.value;
  } else if (lengthValue?.kind === "ref") {
    // pdf.js resolves the reference through the xref — possibly to an object
    // inside an object stream — which this does not read. A top-level
    // `N G obj <integer>` in the raw bytes is not that object: a decoy one,
    // with `endstream` planted at the matching offset, would slice a bomb
    // there. So an indirect length is unknown, and measuring runs to where
    // the compressed data itself ends. (Henry, round 4 on #985.)
    length = undefined;
  }

  if (length !== undefined && length >= 0 && dataStart + length <= bytes.length) {
    // pdf.js lexes whatever sits at start + Length and only asks whether it is
    // the `endstream` keyword. That position is often inside binary data (real
    // files carry wrong lengths), so this compares bytes rather than running the
    // strict tokeniser, which would refuse the binary instead of saying "no".
    const at = skipGap(bytes, dataStart + length);
    if (
      startsWith(bytes, at, ENDSTREAM_KEYWORD) &&
      (at + ENDSTREAM_KEYWORD.length >= bytes.length || !isRegular(bytes[at + ENDSTREAM_KEYWORD.length]))
    ) {
      return { dataEnd: dataStart + length, resumeAt: at };
    }
  }

  const found = pdfjsFindStreamEnd(bytes, dataStart);
  if (found === -1) throw cannotCheck(`stream at ${dataStart} has no endstream`);
  // With an indirect /Length, pdf.js may use a longer region than the search
  // finds, so the end is unknown; the search still says where the structure
  // can resume at the earliest.
  return { dataEnd: length === undefined ? undefined : found, resumeAt: found };
}

/**
 * One object, parsed as pdf.js parses the object an xref offset points at.
 * Returns the stream it holds, or null for any other object.
 */
function parseObjectAt(
  bytes: Uint8Array,
  at: number
): { stream: ParsedStream | null; resumeAt: number; value: PdfValue; num: number; gen: number } {
  const lexer = new Lexer(bytes, at, bytes.length);
  const parser = new Parser(lexer);
  const num = parser.next();
  const gen = parser.next();
  const obj = parser.next();
  if (
    num.kind !== "number" ||
    !num.integer ||
    gen.kind !== "number" ||
    !gen.integer ||
    obj.kind !== "keyword" ||
    obj.value !== "obj"
  ) {
    throw cannotCheck(`expected an object header at ${at}`);
  }

  // `N G obj endobj`: pdf.js reads the `endobj` command itself as the value
  // (real dvips output has empty objects). Leave it for the walk to consume.
  const first = parser.peek();
  if (first.kind === "keyword" && first.value === "endobj") {
    return { stream: null, resumeAt: first.start, value: { kind: "null" }, num: num.value, gen: gen.value };
  }
  const value = parser.value();
  const after = parser.peek();
  if (after.kind !== "keyword" || after.value !== "stream" || value.kind !== "dict") {
    return { stream: null, resumeAt: after.start, value, num: num.value, gen: gen.value };
  }
  parser.next();
  if (parser.hasLookahead()) throw cannotCheck(`read past stream keyword at ${after.start}`);

  const dataStart = skipToNextLine(bytes, after.end);
  const { dataEnd, resumeAt } = streamRegion(bytes, value.entries, dataStart);
  return {
    stream: { dict: value.entries, keywordAt: after.start, dataStart, dataEnd },
    resumeAt,
    value,
    num: num.value,
    gen: gen.value,
  };
}

/**
 * Tokenise the whole file's top-level structure — objects, xref tables,
 * trailers — skipping each stream's data the way pdf.js does. Then parse, on
 * its own, every object header the raw scan found that the walk did not: pdf.js
 * can reach those through an xref offset, so a stream there is measured too.
 */
function parseFile(bytes: Uint8Array): {
  headers: Set<number>;
  streams: ParsedStream[];
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // pdf.js takes the trailer from the last `startxref`, so a trailer after the
  // final %%EOF — one carrying /Encrypt, say — would be structure this never
  // read. Objects and streams there are caught by the raw scans; an xref section
  // or trailer is refused. Anything else is tolerated: real files end in stray
  // comments and padding (ConTeXt writes `%%EOF\r\n%\0\n`).
  const eofAt = buffer.lastIndexOf(EOF_MARKER);
  let end = bytes.length;
  if (eofAt !== -1) {
    end = eofAt + EOF_MARKER.length;
    const tail = buffer.subarray(end);
    if (tail.includes("xref", 0, "latin1") || tail.includes("trailer", 0, "latin1")) {
      throw cannotCheck("xref or trailer after the final %%EOF");
    }
  }

  const raw = scanRaw(bytes);

  const lexer = new Lexer(bytes, 0, end);
  const parser = new Parser(lexer);
  const headers = new Set<number>();
  const streams = new Map<number, ParsedStream>();

  for (;;) {
    const token = parser.peek();
    if (token.kind === "eof") break;

    if (token.kind === "number" && token.integer) {
      const parsed = parseObjectAt(bytes, token.start);
      headers.add(token.start);
      if (parsed.stream) streams.set(parsed.stream.keywordAt, parsed.stream);

      // Resume the walk where the object ended.
      lexer.pos = parsed.resumeAt;
      parser.reset();
      // pdf.js reads an object from its header and stops; nothing requires an
      // `endobj` after it, and real files omit one or leave a dictionary
      // unclosed until a later `>>`. The walk just carries on from where the
      // object ended; anything it skips still reaches the stray-header pass.
      if (parsed.stream) {
        const close = parser.peek();
        if (close.kind === "keyword" && ["endstream", "endsteam", "endstrea"].includes(close.value)) {
          parser.next();
        }
      }
      const endobj = parser.peek();
      if (endobj.kind === "keyword" && endobj.value === "endobj") parser.next();
      continue;
    }

    parser.next();
    if (token.kind === "keyword" && token.value === "xref") {
      for (;;) {
        const entry = parser.peek();
        const isEntry =
          (entry.kind === "number" && entry.integer) ||
          (entry.kind === "keyword" && (entry.value === "n" || entry.value === "f"));
        if (!isEntry) break;
        parser.next();
      }
      const trailer = parser.next();
      if (trailer.kind !== "keyword" || trailer.value !== "trailer") {
        throw cannotCheck(`xref table at ${token.start} not followed by trailer`);
      }
      if (parser.value().kind !== "dict") throw cannotCheck(`trailer at ${trailer.start} is not a dictionary`);
      continue;
    }

    // A trailer without an xref table in front of it: pdf.js's recovery mode
    // scans for `trailer` and reads the dictionary after it, so it is parsed —
    // which also puts any /Encrypt in it through the encryption check.
    if (token.kind === "keyword" && token.value === "trailer") {
      if (parser.value().kind !== "dict") throw cannotCheck(`trailer at ${token.start} is not a dictionary`);
      continue;
    }

    if (token.kind === "keyword" && token.value === "startxref") {
      const offset = parser.next();
      if (offset.kind !== "number" || !offset.integer) throw cannotCheck(`bad startxref at ${token.start}`);
      continue;
    }

    // A stray `endobj` is noise pdf.js never parses as structure (real dvips
    // output has one).
    if (token.kind === "keyword" && token.value === "endobj") continue;

    throw cannotCheck(`unexpected ${token.kind}${"value" in token ? ` "${token.value}"` : ""} at ${token.start}`);
  }

  // Headers the walk did not pass — in comments (pdfTeX writes `% 168 0 obj`),
  // inside another stream's data (an embedded file's stored deflate block), or
  // anywhere an xref offset could point. Parsed on their own, as pdf.js would.
  const MAX_STRAY_HEADERS = 10_000;
  const stray = raw.headers.filter((at) => !headers.has(at));
  if (stray.length > MAX_STRAY_HEADERS) throw cannotCheck("too many object headers outside the structure");
  for (const at of stray) {
    const parsed = parseObjectAt(bytes, at);
    headers.add(at);
    if (parsed.stream && !streams.has(parsed.stream.keywordAt)) {
      streams.set(parsed.stream.keywordAt, parsed.stream);
    }
  }

  const keywords = new Set(streams.keys());
  for (const at of raw.streamKeywords) {
    if (!keywords.has(at)) throw cannotCheck(`stream outside any object at ${at}`);
  }

  return { headers, streams: [...streams.values()] };
}

// Raw scans for what pdf.js can reach without this tokeniser's help: an object
// header (xref offsets, recovery's raw scan) and a dictionary followed by the
// `stream` keyword, anywhere in the bytes — inside strings, comments and other
// streams' data included. Read as broadly as either pdf.js path reads them:
// the lexer (whitespace and `%` comments between parts; an xref offset can
// point into the middle of any line, so each position is a fresh start) and
// recovery's `/^(\d+)\s+(\d+)\s+obj\b/` (whose `\s` also takes VT and NBSP).
//
// Both scans are one right-to-left pass. Regular expressions backtracked
// exponentially on runs of whitespace, NUL and `%` — which binary stream data is
// full of; one real 395KB file hung them — and a left-to-right scan re-skipped a
// long gap once per attempt, which a crafted file makes quadratic. Walking
// backwards, where the whitespace-and-comment gap starting at each byte ends is
// known from the byte after it (or, for `%`, from the end of its line), so every
// position is visited once.

const STREAM_KEYWORD = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "stream"

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isWordByte(byte: number): boolean {
  return (
    isDigit(byte) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f
  );
}

/** Lexer whitespace, plus VT and NBSP, which recovery's `\s` accepts. */
function isGapByte(byte: number): boolean {
  return isWhitespace(byte) || byte === 0x0b || byte === 0xa0;
}

function startsWith(bytes: Uint8Array, at: number, word: number[]): boolean {
  if (at + word.length > bytes.length) return false;
  for (let k = 0; k < word.length; k++) if (bytes[at + k] !== word[k]) return false;
  return true;
}

function scanRaw(bytes: Uint8Array): { headers: number[]; streamKeywords: number[] } {
  const n = bytes.length;
  const headers: number[] = [];
  const streamKeywords: number[] = [];
  // Digit runs that are a valid generation number: gap, then `obj`, then a
  // non-word byte. One bit per byte.
  const generation = new Uint8Array((n >> 3) + 1);
  const isGeneration = (at: number) => (generation[at >> 3] >> (at & 7)) & 1;

  let gapAfterNext = n; // gap end at i + 2
  let gapAfter = n; //     gap end at i + 1
  let gapAtNextEol = n; // gap end at the next CR/LF to the right
  let digitRunGap = n; //  gap end right after the digit run being walked

  for (let i = n - 1; i >= 0; i--) {
    const byte = bytes[i];

    let gap: number;
    if (byte === 0x25) gap = gapAtNextEol; // a comment runs to its line's end
    else if (isGapByte(byte)) gap = gapAfter;
    else gap = i;
    if (byte === 0x0a || byte === 0x0d) gapAtNextEol = gap;

    if (byte === 0x3e && i + 1 < n && bytes[i + 1] === 0x3e) {
      const at = gapAfterNext;
      if (
        startsWith(bytes, at, STREAM_KEYWORD) &&
        (at + 6 >= n || !isRegular(bytes[at + 6]))
      ) {
        streamKeywords.push(at);
      }
    }

    if (isDigit(byte)) {
      if (i + 1 >= n || !isDigit(bytes[i + 1])) digitRunGap = gapAfter;
      if (i === 0 || !isDigit(bytes[i - 1])) {
        // A whole digit run [i, end). `end` is where its gap starts; a gap of
        // zero bytes means the run is glued to what follows.
        let end = i + 1;
        while (end < n && isDigit(bytes[end])) end++;
        const next = digitRunGap;
        if (next > end) {
          if (
            startsWith(bytes, next, [0x6f, 0x62, 0x6a]) &&
            (next + 3 >= n || !isWordByte(bytes[next + 3]))
          ) {
            generation[i >> 3] |= 1 << (i & 7);
          }
          if (next < n && isDigit(bytes[next]) && isGeneration(next)) {
            headers.push(i);
          }
        }
      }
    }

    gapAfterNext = gapAfter;
    gapAfter = gap;
  }

  return { headers, streamKeywords };
}


/** Whether decoded bytes hold a `>> stream` anywhere — see the object-stream rule. */
function containsStream(bytes: Uint8Array): boolean {
  return scanRaw(bytes).streamKeywords.length > 0;
}

// ── filters ───────────────────────────────────────────────────────────────

const FLATE = new Set(["FlateDecode", "Fl"]);
const RUN_LENGTH = new Set(["RunLengthDecode", "RL"]);
const LZW = new Set(["LZWDecode", "LZW"]);
const ASCII_HEX = new Set(["ASCIIHexDecode", "AHx"]);
const ASCII_85 = new Set(["ASCII85Decode", "A85"]);

type TextStage = "hex" | "85";

type Plan = {
  /** ASCIIHex / ASCII85 stages pdf.js runs before anything else, in order. */
  text: TextStage[];
  /** The one expanding stage, if any, and the parameters pdf.js gives it. */
  expanding: "flate" | "runLength" | null;
  params: PdfValue | undefined;
  /** Whether any filter at all is declared. */
  filtered: boolean;
};

/**
 * How pdf.js will decode this stream, reduced to what can expand.
 *
 * Accepted shape: leading ASCIIHex/ASCII85 stages (older producers hex-encode
 * compressed data), then at most one Flate or RunLength, then only filters
 * that cannot expand. ASCII85 counts as expanding once something else has run
 * before it: `z` is four zero bytes, so it multiplies output it did not measure.
 */
function planFor(dict: Map<string, PdfValue>): Plan {
  const filter = dict.get("F") ?? dict.get("Filter");
  const params = dict.get("DP") ?? dict.get("DecodeParms");
  const none: Plan = { text: [], expanding: null, params: undefined, filtered: false };
  if (filter === undefined || filter.kind === "null") return none;

  let names: string[];
  let paramsAt: (index: number) => PdfValue | undefined;
  if (filter.kind === "name") {
    names = [filter.value];
    paramsAt = () => params;
  } else if (filter.kind === "array") {
    names = filter.items.map((item) => {
      if (item.kind !== "name") throw cannotCheck("filter array holds a non-name");
      return item.value;
    });
    // pdf.js only reads per-filter parameters from an array; anything else is
    // treated as none.
    paramsAt = (index) => (params?.kind === "array" ? params.items[index] : undefined);
  } else if (filter.kind === "ref") {
    // pdf.js resolves it; this cannot, so it cannot tell what would run.
    throw cannotCheck("filter is an indirect reference");
  } else {
    // pdf.js decodes only for a name or an array and returns the stream as-is
    // otherwise — `/F` as a file specification string, for instance.
    return none;
  }

  if (names.some((name) => LZW.has(name))) {
    throw refuse("PDF uses a compression format this service does not accept");
  }

  const text: TextStage[] = [];
  let i = 0;
  while (i < names.length && (ASCII_HEX.has(names[i]) || ASCII_85.has(names[i]))) {
    text.push(ASCII_HEX.has(names[i]) ? "hex" : "85");
    i++;
  }

  let expanding: Plan["expanding"] = null;
  let expandingParams: PdfValue | undefined;
  if (i < names.length && (FLATE.has(names[i]) || RUN_LENGTH.has(names[i]))) {
    expanding = FLATE.has(names[i]) ? "flate" : "runLength";
    expandingParams = paramsAt(i);
    i++;
  }

  // pdf.js applies the whole array in order. Anything after this point that
  // could expand decodes bytes this scan never measured.
  for (const name of names.slice(i)) {
    if (FLATE.has(name) || RUN_LENGTH.has(name) || ASCII_85.has(name)) {
      throw cannotCheck(`filter chain [${names.join(" ")}]`);
    }
  }

  return { text, expanding, params: expandingParams, filtered: true };
}

/** pdf.js AsciiHexStream: hex digits only, other bytes skipped, `>` ends it. */
function decodeAsciiHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array((data.length + 1) >> 1);
  let length = 0;
  let high = -1;
  for (const byte of data) {
    if (byte === 0x3e) break;
    const value = hexValue(byte);
    if (value === -1) continue;
    if (high < 0) {
      high = value;
    } else {
      out[length++] = (high << 4) | value;
      high = -1;
    }
  }
  if (high >= 0) out[length++] = high << 4;
  return out.subarray(0, length);
}

/**
 * pdf.js Ascii85Stream: whitespace skipped, `~` or the end stops it, `z` is four
 * zero bytes — so it can expand 4:1 and is decoded against the budget.
 */
function decodeAscii85(data: Uint8Array, limit: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    length += bytes.length;
    if (length > limit) {
      throw refuse("PDF contains a compressed stream that expands too far to process safely");
    }
    chunks.push(bytes);
  };

  let i = 0;
  const nextByte = () => {
    while (i < data.length && isWhitespace(data[i])) i++;
    return i < data.length ? data[i++] : -1;
  };
  for (;;) {
    const first = nextByte();
    if (first === -1 || first === 0x7e) break;
    if (first === 0x7a) {
      push(new Uint8Array(4));
      continue;
    }
    const group = [first, 0, 0, 0, 0];
    let count = 1;
    let ended = false;
    for (; count < 5; count++) {
      const byte = nextByte();
      if (byte === -1 || byte === 0x7e) {
        ended = true;
        break;
      }
      group[count] = byte;
    }
    for (let k = count; k < 5; k++) group[k] = 0x75;
    let value = 0;
    for (let k = 0; k < 5; k++) value = value * 85 + (group[k] - 33);
    const word = new Uint8Array(4);
    for (let k = 3; k >= 0; k--) {
      word[k] = value & 0xff;
      value = Math.floor(value / 256);
    }
    push(word.subarray(0, count - 1));
    if (ended) break;
  }

  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Run the leading text stages, as pdf.js would, from the start of the data. */
function applyTextStages(data: Uint8Array, stages: TextStage[], limit: number): Uint8Array {
  let bytes = data;
  for (const stage of stages) {
    bytes = stage === "hex" ? decodeAsciiHex(bytes) : decodeAscii85(bytes, limit);
  }
  return bytes;
}

function directInteger(dict: Map<string, PdfValue>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = dict.get(key);
    if (value === undefined) continue;
    if (value.kind !== "number" || !value.integer) throw cannotCheck(`predictor /${key} is not a direct integer`);
    return value.value;
  }
  return undefined;
}

/**
 * The row buffer a predictor allocates, in bytes, or 0 without one.
 * `PredictorStream` sizes it from the parameters, not from the data, so a
 * 12-byte stream can ask for a row of any size.
 */
function predictorRowBytes(params: PdfValue | undefined): number {
  if (params === undefined || params.kind === "null") return 0;
  // pdf.js resolves a reference here (dict.get / fetchIfRef), and what it points
  // to could be a dictionary asking for any row size; this cannot follow it.
  if (params.kind === "ref") throw cannotCheck("filter parameters are an indirect reference");
  if (params.kind !== "dict") return 0; // pdf.js ignores non-dictionary parameters
  const predictor = directInteger(params.entries, "Predictor") ?? 1;
  if (predictor <= 1) return 0;
  const colors = directInteger(params.entries, "Colors") || 1;
  const bits = directInteger(params.entries, "BPC", "BitsPerComponent") || 8;
  const columns = directInteger(params.entries, "Columns") || 1;
  if (colors < 0 || bits < 0 || columns < 0) throw cannotCheck("negative predictor parameter");
  return Math.ceil((columns * colors * bits) / 8);
}

// ── measuring ─────────────────────────────────────────────────────────────

/** pdf.js FlateStream's header check: method 8, FCHECK, no FDICT. CINFO is not checked. */
function pdfjsAcceptsFlateHeader(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const cmf = data[0];
  const flg = data[1];
  return (cmf & 0x0f) === 8 && ((cmf << 8) + flg) % 31 === 0 && (flg & 0x20) === 0;
}

// ── pdf.js FlateStream, ported to count ──────────────────────────────────
//
// Node's zlib is not pdf.js's inflater, and the gap matters both ways. zlib
// rejects a zlib window over 32K and back-references past the start of the
// output; pdf.js checks neither (`e[o] = e[o - l]` just reads zero) and keeps
// going. So zlib erred on real files pdf.js reads fine, and an error left the
// stream unmeasured — while pdf.js would still inflate it. This is pdf.js's
// readBlock, line for line, with its quirks (stored blocks that claim their
// full length on short input, leftover bits dropped before a stored header,
// `undefined` table entries read as 0), counting output instead of storing it.
// It stops exactly where pdf.js stops: end of the final block, or the point
// where pdf.js would throw. What pdf.js allocated before throwing is counted.

/** pdf.js `FlateStream#generateHuffmanTable`. */
function generateHuffmanTable(lengths: Uint8Array): [Int32Array, number] {
  let maxLength = 0;
  for (const length of lengths) if (length > maxLength) maxLength = length;
  const size = 1 << maxLength;
  const table = new Int32Array(size);
  for (let length = 1, code = 0, skip = 2; length <= maxLength; ++length, code <<= 1, skip <<= 1) {
    for (let symbol = 0; symbol < lengths.length; ++symbol) {
      if (lengths[symbol] !== length) continue;
      let reversed = 0;
      let bits = code;
      for (let i = 0; i < length; ++i) {
        reversed = (reversed << 1) | (bits & 1);
        bits >>= 1;
      }
      for (let i = reversed; i < size; i += skip) table[i] = (length << 16) | symbol;
      ++code;
    }
  }
  return [table, maxLength];
}

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_DECODE = [
  3, 4, 5, 6, 7, 8, 9, 10, 65547, 65549, 65551, 65553, 131091, 131095, 131099, 131103, 196643,
  196651, 196659, 196667, 262211, 262227, 262243, 262259, 327811, 327843, 327875, 327907, 258, 258,
  258,
];
const DISTANCE_DECODE = [
  1, 2, 3, 4, 65541, 65543, 131081, 131085, 196625, 196633, 262177, 262193, 327745, 327777, 393345,
  393409, 459009, 459137, 524801, 525057, 590849, 591361, 657409, 658433, 724993, 727041, 794625,
  798721, 868353, 876545,
];
// pdf.js ships these as constants; they are exactly these generated tables
// (checked against the bundle: 288 literal lengths, 30 distance codes).
const FIXED_LITERALS = generateHuffmanTable(
  new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
);
const FIXED_DISTANCES = generateHuffmanTable(new Uint8Array(30).fill(5));

/** Where pdf.js throws a FormatError: decoding stops there, as it does in pdf.js. */
class FlateStop extends Error {}

class PdfjsFlate {
  private pos = 0;
  private codeSize = 0;
  private codeBuf = 0;
  private eof = false;
  /** pdf.js's bufferLength/ensureBuffer high-water mark: what it allocated. */
  length = 0;
  private output: Uint8Array | null;

  constructor(
    private readonly input: Uint8Array,
    private readonly limit: number,
    keep: boolean
  ) {
    this.output = keep ? new Uint8Array(Math.min(limit, 1 << 16)) : null;
  }

  private getByte(): number {
    return this.pos < this.input.length ? this.input[this.pos++] : -1;
  }

  private getBits(count: number): number {
    let size = this.codeSize;
    let buffer = this.codeBuf;
    while (size < count) {
      const byte = this.getByte();
      if (byte === -1) throw new FlateStop("Bad encoding in flate stream");
      buffer |= byte << size;
      size += 8;
    }
    const bits = buffer & ((1 << count) - 1);
    this.codeBuf = buffer >> count;
    this.codeSize = size - count;
    return bits;
  }

  private getCode([table, maxLength]: [Int32Array, number]): number {
    let size = this.codeSize;
    let buffer = this.codeBuf;
    let byte: number;
    while (size < maxLength && (byte = this.getByte()) !== -1) {
      buffer |= byte << size;
      size += 8;
    }
    const entry = table[buffer & ((1 << maxLength) - 1)];
    const length = entry >> 16;
    if (length < 1 || size < length) throw new FlateStop("Bad encoding in flate stream");
    this.codeBuf = buffer >> length;
    this.codeSize = size - length;
    return entry & 0xffff;
  }

  /** Grow the high-water mark, keeping bytes only when asked to. */
  private reach(end: number): void {
    if (end > this.length) this.length = end;
    if (this.length > this.limit) throw new FlateStop("over budget");
    if (this.output && end > this.output.length) {
      let size = this.output.length;
      while (size < end) size *= 2;
      const grown = new Uint8Array(Math.min(size, this.limit));
      grown.set(this.output);
      this.output = grown;
    }
  }

  private readBlock(): void {
    let header: number;
    try {
      header = this.getBits(3);
    } catch {
      this.eof = true;
      return;
    }
    if (header & 1) this.eof = true;
    header >>= 1;

    if (header === 0) {
      // Stored: the next four bytes, whatever bits are still buffered.
      const bytes = [this.getByte(), this.getByte(), this.getByte(), this.getByte()];
      if (bytes.includes(-1)) {
        this.eof = true;
        return;
      }
      const blockLength = bytes[0] | (bytes[1] << 8);
      const check = bytes[2] | (bytes[3] << 8);
      if (check !== (~blockLength & 0xffff) && (blockLength !== 0 || check !== 0)) {
        throw new FlateStop("Bad uncompressed block length in flate stream");
      }
      this.codeBuf = 0;
      this.codeSize = 0;
      const start = this.length;
      this.reach(start + blockLength); // claimed in full, even on short input
      if (blockLength === 0) {
        if (this.pos >= this.input.length) this.eof = true;
      } else {
        const available = Math.min(blockLength, this.input.length - this.pos);
        this.output?.set(this.input.subarray(this.pos, this.pos + available), start);
        this.pos += available;
        if (available < blockLength) this.eof = true;
      }
      return;
    }

    let literals: [Int32Array, number];
    let distances: [Int32Array, number];
    if (header === 1) {
      literals = FIXED_LITERALS;
      distances = FIXED_DISTANCES;
    } else if (header === 2) {
      const literalCount = this.getBits(5) + 257;
      const distanceCount = this.getBits(5) + 1;
      const codeLengthCount = this.getBits(4) + 4;
      const codeLengths = new Uint8Array(CODE_LENGTH_ORDER.length);
      for (let i = 0; i < codeLengthCount; ++i) codeLengths[CODE_LENGTH_ORDER[i]] = this.getBits(3);
      const codeLengthTable = generateHuffmanTable(codeLengths);

      const total = literalCount + distanceCount;
      const lengths = new Uint8Array(total);
      let previous = 0;
      let i = 0;
      while (i < total) {
        const code = this.getCode(codeLengthTable);
        let bits: number;
        let base: number;
        let value: number;
        if (code === 16) {
          bits = 2;
          base = 3;
          value = previous;
        } else if (code === 17) {
          bits = 3;
          base = 3;
          value = previous = 0;
        } else if (code === 18) {
          bits = 7;
          base = 11;
          value = previous = 0;
        } else {
          lengths[i++] = previous = code;
          continue;
        }
        let repeat = this.getBits(bits) + base;
        // Writes past the end are dropped, as on pdf.js's fixed-size array.
        while (repeat-- > 0) {
          if (i < total) lengths[i] = value;
          i++;
        }
      }
      literals = generateHuffmanTable(lengths.subarray(0, literalCount));
      distances = generateHuffmanTable(lengths.subarray(literalCount, total));
    } else {
      throw new FlateStop("Unknown block type in flate stream");
    }

    for (;;) {
      let symbol = this.getCode(literals);
      if (symbol < 256) {
        const at = this.length;
        this.reach(at + 1);
        if (this.output) this.output[at] = symbol;
        continue;
      }
      if (symbol === 256) return;

      // Out-of-range entries are `undefined` in pdf.js and read as 0.
      symbol = LENGTH_DECODE[symbol - 257] ?? 0;
      let extra = symbol >> 16;
      if (extra > 0) extra = this.getBits(extra);
      const length = (symbol & 0xffff) + extra;
      symbol = DISTANCE_DECODE[this.getCode(distances)] ?? 0;
      extra = symbol >> 16;
      if (extra > 0) extra = this.getBits(extra);
      const distance = (symbol & 0xffff) + extra;

      const at = this.length;
      this.reach(at + length);
      if (this.output) {
        // No distance check, as in pdf.js: before the start reads as 0.
        for (let k = 0; k < length; ++k) {
          const from = at + k - distance;
          this.output[at + k] = from >= 0 ? this.output[from] : 0;
        }
      }
    }
  }

  /** Decode to pdf.js's end, or past `limit`. */
  run(): { size: number; bytes: Uint8Array | null } {
    try {
      while (!this.eof) this.readBlock();
    } catch (error) {
      if (!(error instanceof FlateStop)) throw error;
    }
    return { size: this.length, bytes: this.output?.subarray(0, Math.min(this.length, this.limit)) ?? null };
  }
}

/** pdf.js's Flate output size for `data` (header included), up to `limit`. */
function pdfjsInflatedSize(data: Uint8Array, limit: number): number {
  if (!pdfjsAcceptsFlateHeader(data)) return 0; // pdf.js makes it a NullStream
  return new PdfjsFlate(data.subarray(2), limit, false).run().size;
}

/** pdf.js's Flate output for `data`, up to `limit` bytes. */
function pdfjsInflate(data: Uint8Array, limit: number): Uint8Array {
  if (!pdfjsAcceptsFlateHeader(data)) return new Uint8Array(0);
  return new PdfjsFlate(data.subarray(2), limit, true).run().bytes ?? new Uint8Array(0);
}

/** RunLengthDecode output size, from the length bytes, without decoding. */
function runLengthSize(data: Uint8Array, limit: number): number {
  let size = 0;
  let i = 0;
  while (i < data.length && size <= limit) {
    const length = data[i];
    if (length === 128) break;
    if (length < 128) {
      size += length + 1;
      i += length + 2;
    } else {
      size += 257 - length;
      i += 2;
    }
  }
  return size;
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * Refuse a PDF whose streams would decompress past the budget — or whose
 * structure cannot be read the way pdf.js reads it — before pdf.js inflates
 * anything. Returns quietly when the file is within budget.
 */
export async function assertPdfDecompressionWithinBudget(
  bytes: Uint8Array,
  limits: PdfGuardLimits = DEFAULT_LIMITS
): Promise<void> {
  const { streams } = parseFile(bytes);

  if (streams.length > limits.streams) {
    throw refuse(`PDF has ${streams.length} streams, over the ${limits.streams} limit`);
  }

  let total = 0;
  for (const stream of streams) {
    const plan = planFor(stream.dict);
    // pdf.js requires both (fetchCompressed reads First and N); /N alone is on
    // every ICC colour profile, which is not an object stream.
    const couldBeObjectStream = stream.dict.has("First") && stream.dict.has("N");
    const budget = Math.min(limits.perStream, limits.total - total);

    if (predictorRowBytes(plan.params) > limits.perStream) {
      throw refuse("PDF contains a compressed stream that expands too far to process safely");
    }

    // Decoding covers exactly the bytes pdf.js hands the filter (see
    // streamRegion). Where that cannot be known it runs to the end of the file:
    // each stage stops at its own end marker, so this measures at least as much
    // as pdf.js could.
    const data =
      stream.dataEnd === undefined
        ? bytes.subarray(stream.dataStart)
        : bytes.subarray(stream.dataStart, stream.dataEnd);
    const input = applyTextStages(data, plan.text, limits.perStream);

    let size = 0;
    if (plan.expanding === "runLength") {
      if (couldBeObjectStream) throw cannotCheck("RunLength object stream");
      size = runLengthSize(input, budget);
    } else if (plan.expanding === "flate") {
      size = pdfjsInflatedSize(input, budget);
    } else if (plan.text.length > 0) {
      size = input.length;
    }

    if (size > limits.perStream) {
      throw refuse("PDF contains a compressed stream that expands too far to process safely");
    }
    total += size;
    if (total > limits.total) {
      throw refuse("PDF expands too far in total to process safely");
    }

    // pdf.js parses object streams with allowStreams: true and accepts any
    // stream with /First and /N as one, so a stream compressed inside another
    // is invisible to the raw scans. The spec forbids streams there; refuse any.
    // An unfiltered one is already covered by the raw scans.
    if (couldBeObjectStream && plan.filtered) {
      if (predictorRowBytes(plan.params) > 0) throw cannotCheck("object stream with a predictor");
      let decoded: Uint8Array = input;
      if (plan.expanding === "flate") {
        decoded = pdfjsInflate(input, limits.perStream);
      } else if (plan.text.length === 0) {
        throw cannotCheck("object stream behind a filter this cannot decode");
      }
      if (containsStream(decoded)) throw cannotCheck("stream inside an object stream");
    }
  }
}

/** Internal decoders, exposed only so tests can pin them to pdf.js's behaviour. */
export const __test = { pdfjsInflate, pdfjsInflatedSize };
