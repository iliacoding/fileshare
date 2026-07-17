/* ==========================================================================
   Beam — peer-to-peer file transfer
   --------------------------------------------------------------------------
   A single-page, dependency-free WebRTC file transfer app.

   There is no signalling server, so the two peers exchange their SDP by hand
   (QR code or copy/paste). To make that practical the SDP is stripped down to
   the handful of fields that actually matter, deflated, and base64url'd — a
   full offer is ~3 KB of text, the compacted form is ~300 bytes, which fits
   comfortably in a QR code you can scan across a table.

   Module map:
     Util        — DOM helpers, formatting, toasts
     Signal      — SDP <-> compact handshake token
     QrEncoder   — QR code generation (byte mode, ECC L/M)
     QrDecoder   — QR code recognition from raw image data
     Scanner     — camera + decode loop
     Peer        — RTCPeerConnection lifecycle
     Transfer    — chunked file send/receive with backpressure
     App         — UI wiring
   ========================================================================== */

'use strict';

/* ==========================================================================
   Util
   ========================================================================== */
const Util = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /** Human-readable byte count (decimal units, matching OS file managers). */
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1000) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1000;
    let i = 0;
    while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
  };

  const formatSpeed = (bytesPerSecond) =>
    Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
      ? `${formatBytes(bytesPerSecond)}/s`
      : '—';

  /** Seconds -> "1m 20s" / "45s" / "1h 4m". */
  const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return 'less than a second';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  /** Short uppercase extension badge for a filename. */
  const fileExt = (name) => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) return 'FILE';
    return name.slice(dot + 1).slice(0, 4).toUpperCase();
  };

  /** Strip path separators and control characters from a peer-supplied name. */
  const sanitizeFilename = (name) => {
    const cleaned = String(name || 'file')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\/]/g, '_')
      .replace(/^\.+/, '')
      .trim();
    return cleaned.slice(0, 180) || 'file';
  };

  /* ---- base64url ---- */
  const bytesToBase64Url = (bytes) => {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const base64UrlToBytes = (str) => {
    const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  const bytesToBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const base64ToBytes = (str) => {
    const binary = atob(str);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  /* ---- toasts ---- */
  const toastStack = () => document.getElementById('toastStack');

  const toast = (message, kind = 'info', ms = 4200) => {
    const stack = toastStack();
    if (!stack) return;
    const node = el('div', 'toast');
    node.dataset.kind = kind;
    node.appendChild(el('span', null, message));
    stack.appendChild(node);
    const remove = () => {
      node.classList.add('is-out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
      // Safety net in case the animation never fires (e.g. reduced motion).
      setTimeout(() => node.remove(), 500);
    };
    setTimeout(remove, ms);
    node.addEventListener('click', remove);
  };

  /** Copy with a graceful fallback for non-secure contexts / older Safari. */
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  const readClipboard = async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) return null;
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  };

  const vibrate = (pattern) => {
    try { navigator.vibrate?.(pattern); } catch { /* not supported — ignore */ }
  };

  return {
    $, $$, el, formatBytes, formatSpeed, formatDuration, fileExt, sanitizeFilename,
    bytesToBase64Url, base64UrlToBytes, bytesToBase64, base64ToBytes,
    toast, copyText, readClipboard, vibrate,
  };
})();

/* ==========================================================================
   QrEncoder — QR code generation

   Byte mode only (our payload is base64url ASCII). Implements the standard
   pipeline: segment -> data codewords -> Reed-Solomon ECC -> interleave ->
   module placement -> mask selection by penalty score.
   ========================================================================== */
const QrEncoder = (() => {
  // ECC codewords per block, indexed [eccLevel][version]. Index 0 is unused.
  const ECC_CODEWORDS_PER_BLOCK = [
    // 1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
  ];

  const NUM_ECC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
  ];

  // Format-info bit patterns per ECC level (L, M, Q, H).
  const ECC_FORMAT_BITS = [1, 0, 3, 2];

  const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  /* ---- shared geometry helpers (also used by the decoder) ---- */

  /** Centres of the alignment patterns for a version, in module coordinates. */
  function alignmentPatternPositions(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /** Total module count available for data + ECC, before function patterns. */
  function numRawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  const numRawCodewords = (version) => Math.floor(numRawDataModules(version) / 8);

  function numDataCodewords(version, ecc) {
    return numRawCodewords(version)
      - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ECC_BLOCKS[ecc][version];
  }

  /* ---- Reed-Solomon (encoding side) ---- */

  /** Multiply in GF(2^8) with the QR primitive polynomial x^8+x^4+x^3+x^2+1. */
  function rsMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  /** Generator polynomial coefficients for the given degree. */
  function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
    }
    return result;
  }

  /* ---- bit buffer ---- */
  class BitBuffer {
    constructor() { this.bits = []; }
    append(value, length) {
      for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    }
    get length() { return this.bits.length; }
  }

  /* ---- data assembly ---- */

  function makeDataCodewords(bytes, version, ecc) {
    const capacityBits = numDataCodewords(version, ecc) * 8;
    const bb = new BitBuffer();
    bb.append(0b0100, 4);                                   // byte mode
    bb.append(bytes.length, version <= 9 ? 8 : 16);         // character count
    for (const b of bytes) bb.append(b, 8);

    if (bb.length > capacityBits) return null;              // caller picks a bigger version

    bb.append(0, Math.min(4, capacityBits - bb.length));    // terminator
    bb.append(0, (8 - (bb.length % 8)) % 8);                // pad to a byte boundary

    // Alternating pad bytes, per the spec.
    for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

    const out = new Uint8Array(bb.length / 8);
    bb.bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
    return out;
  }

  /**
   * Split data into blocks, append per-block ECC, and interleave.
   * Short blocks get a throwaway byte so every block has the same length; that
   * byte is skipped while interleaving (this mirrors the spec's layout).
   */
  function addEccAndInterleave(data, version, ecc) {
    const numBlocks = NUM_ECC_BLOCKS[ecc][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
    const rawCodewords = numRawCodewords(version);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const divisor = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = Array.from(data.slice(k, k + dataLen));
      k += dataLen;
      const eccBytes = Array.from(rsRemainder(dat, divisor));
      if (i < numShortBlocks) dat.push(0);                  // placeholder, skipped below
      blocks.push(dat.concat(eccBytes));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    return Uint8Array.from(result);
  }

  /* ---- module placement ---- */

  class Matrix {
    constructor(size) {
      this.size = size;
      this.modules = new Uint8Array(size * size);
      this.isFunction = new Uint8Array(size * size);
    }
    get(x, y) { return this.modules[y * this.size + x]; }
    set(x, y, dark) { this.modules[y * this.size + x] = dark ? 1 : 0; }
    setFunction(x, y, dark) {
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
      this.modules[y * this.size + x] = dark ? 1 : 0;
      this.isFunction[y * this.size + x] = 1;
    }
    fn(x, y) { return this.isFunction[y * this.size + x]; }
  }

  function drawFinder(m, cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));   // Chebyshev ring index
        m.setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlignment(m, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        m.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function drawFormatBits(m, ecc, mask) {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    // First copy — around the top-left finder.
    for (let i = 0; i <= 5; i++) m.setFunction(8, i, (bits >>> i) & 1);
    m.setFunction(8, 7, (bits >>> 6) & 1);
    m.setFunction(8, 8, (bits >>> 7) & 1);
    m.setFunction(7, 8, (bits >>> 8) & 1);
    for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, (bits >>> i) & 1);

    // Second copy — split between the other two finders.
    const size = m.size;
    for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, (bits >>> i) & 1);
    for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, (bits >>> i) & 1);
    m.setFunction(8, size - 8, 1);                           // always-dark module
  }

  function drawFunctionPatterns(m, version, ecc) {
    const size = m.size;

    // Timing patterns.
    for (let i = 0; i < size; i++) {
      m.setFunction(6, i, i % 2 === 0);
      m.setFunction(i, 6, i % 2 === 0);
    }

    drawFinder(m, 3, 3);
    drawFinder(m, size - 4, 3);
    drawFinder(m, 3, size - 4);

    // Alignment patterns, skipping the three that collide with finders.
    const pos = alignmentPatternPositions(version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        drawAlignment(m, pos[i], pos[j]);
      }
    }

    drawFormatBits(m, ecc, 0);                               // placeholder; rewritten per mask

    // Version information (versions 7 and up).
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (bits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        m.setFunction(a, b, bit);
        m.setFunction(b, a, bit);
      }
    }
  }

  /** Zig-zag placement of the codeword bitstream into the non-function modules. */
  function drawCodewords(m, data) {
    const size = m.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                            // skip the vertical timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!m.fn(x, y) && i < data.length * 8) {
            m.set(x, y, (data[i >>> 3] >>> (7 - (i & 7))) & 1);
            i++;
          }
        }
      }
    }
  }

  /** The eight standard mask predicates; applied to non-function modules only. */
  function maskPredicate(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: throw new Error('bad mask');
    }
  }

  function applyMask(m, mask) {
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (!m.fn(x, y) && maskPredicate(mask, x, y)) {
          m.set(x, y, !m.get(x, y));
        }
      }
    }
  }

  /** Standard penalty score used to pick the least-visually-confusing mask. */
  function penaltyScore(m) {
    const size = m.size;
    let result = 0;

    // Counts the 1:1:3:1:1 finder-like patterns sitting in the last 7 runs.
    const countPatterns = (history) => {
      const n = history[1];
      const core = n > 0
        && history[2] === n && history[3] === n * 3
        && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
        + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };

    // The spec treats the area outside the symbol as an infinite light margin,
    // so the first run gets padded with a full-size light border.
    const addHistory = (history, runLength) => {
      if (history[0] === 0) runLength += size;
      history.pop();
      history.unshift(runLength);
    };

    const scanLine = (getter) => {
      const history = [0, 0, 0, 0, 0, 0, 0];
      let runColor = 0;
      let runLength = 0;

      for (let i = 0; i < size; i++) {
        const color = getter(i);
        if (color === runColor) {
          runLength++;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result++;
        } else {
          addHistory(history, runLength);
          // A finder-like pattern is only counted once its trailing light run ends.
          if (runColor === 0) result += countPatterns(history) * PENALTY_N3;
          runColor = color;
          runLength = 1;
        }
      }

      // Terminate the final run, padding it with the light border on the far side.
      if (runColor === 1) {
        addHistory(history, runLength);
        runLength = 0;
      }
      addHistory(history, runLength + size);
      result += countPatterns(history) * PENALTY_N3;
    };

    for (let y = 0; y < size; y++) scanLine((x) => m.get(x, y));
    for (let x = 0; x < size; x++) scanLine((y) => m.get(x, y));

    // 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m.get(x, y);
        if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) {
          result += PENALTY_N2;
        }
      }
    }

    // Balance of dark vs light modules.
    let dark = 0;
    for (let i = 0; i < m.modules.length; i++) dark += m.modules[i];
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;

    return result;
  }

  /* ---- public API ---- */

  /**
   * Encode `text` into a QR module matrix.
   * @returns {{size:number, get(x:number,y:number):number, version:number}}
   */
  function encode(text, { ecc = 0, minVersion = 1, maxVersion = 40 } = {}) {
    const bytes = new TextEncoder().encode(text);

    let version = minVersion;
    let data = null;
    for (; version <= maxVersion; version++) {
      data = makeDataCodewords(bytes, version, ecc);
      if (data) break;
    }
    if (!data) throw new Error('Payload is too large to fit in a QR code.');

    const allCodewords = addEccAndInterleave(data, version, ecc);

    const m = new Matrix(version * 4 + 17);
    drawFunctionPatterns(m, version, ecc);
    drawCodewords(m, allCodewords);

    // Try every mask, keep the best-scoring one.
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(m, mask);
      drawFormatBits(m, ecc, mask);
      const score = penaltyScore(m);
      if (score < bestScore) { bestScore = score; bestMask = mask; }
      applyMask(m, mask);                                    // XOR again to undo
    }
    applyMask(m, bestMask);
    drawFormatBits(m, ecc, bestMask);

    return {
      size: m.size,
      version,
      get: (x, y) => m.get(x, y),
    };
  }

  /** Render a matrix into a canvas at a crisp integer module scale. */
  function render(canvas, matrix, { quiet = 4, target = 512 } = {}) {
    const total = matrix.size + quiet * 2;
    const scale = Math.max(2, Math.floor(target / total));
    const px = total * scale;

    canvas.width = px;
    canvas.height = px;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.get(x, y)) {
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    }
  }

  return {
    encode,
    render,
    alignmentPatternPositions,
    numRawCodewords,
    ECC_CODEWORDS_PER_BLOCK,
    NUM_ECC_BLOCKS,
    maskPredicate,
  };
})();

/* ==========================================================================
   QrDecoder — QR recognition from an ImageData

   Pipeline: adaptive threshold -> locate the three finder patterns ->
   estimate the grid -> perspective-sample into a module matrix -> read the
   format info -> unmask -> de-interleave -> Reed-Solomon correct -> parse.

   Used as a fallback when the native BarcodeDetector API isn't available
   (currently Firefox and desktop Safari).
   ========================================================================== */
const QrDecoder = (() => {

  /* ---- 1. Binarization (Bradley adaptive threshold via integral image) ---- */

  function binarize(imageData) {
    const { width: w, height: h, data } = imageData;
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      // Rec. 601 luma, integer-approximated.
      gray[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    }

    // Integral image for O(1) window sums.
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }

    const bits = new Uint8Array(w * h);
    const radius = Math.max(4, Math.floor(Math.min(w, h) / 16));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
          - integral[y0 * (w + 1) + (x1 + 1)]
          - integral[(y1 + 1) * (w + 1) + x0]
          + integral[y0 * (w + 1) + x0];
        // 6% below the local mean — biases toward keeping thin dark modules.
        bits[y * w + x] = gray[y * w + x] * count < sum * 0.94 ? 1 : 0;
      }
    }

    return { width: w, height: h, get: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bits[y * w + x]) };
  }

  /* ---- 2. Finder pattern detection (1:1:3:1:1 runs) ---- */

  /** True if five consecutive runs match the 1:1:3:1:1 finder ratio. */
  function checkRatio(counts) {
    let total = 0;
    for (const c of counts) {
      if (c === 0) return false;
      total += c;
    }
    if (total < 7) return false;
    const unit = total / 7;
    const tol = unit / 1.6;
    return Math.abs(unit - counts[0]) < tol
      && Math.abs(unit - counts[1]) < tol
      && Math.abs(unit * 3 - counts[2]) < tol * 3
      && Math.abs(unit - counts[3]) < tol
      && Math.abs(unit - counts[4]) < tol;
  }

  const centerFromEnd = (counts, end) =>
    end - counts[4] - counts[3] - counts[2] / 2;

  /** Walk a 1-D line through (startX,startY) and re-measure the 5 runs. */
  function crossCheck(matrix, startX, startY, maxCount, originalTotal, vertical) {
    const counts = [0, 0, 0, 0, 0];
    const limit = vertical ? matrix.height : matrix.width;
    const at = (i) => (vertical ? matrix.get(startX, i) : matrix.get(i, startY));
    let i = vertical ? startY : startX;

    while (i >= 0 && at(i) && counts[2] <= maxCount) { counts[2]++; i--; }
    if (i < 0 || counts[2] > maxCount) return NaN;
    while (i >= 0 && !at(i) && counts[1] <= maxCount) { counts[1]++; i--; }
    if (i < 0 || counts[1] > maxCount) return NaN;
    while (i >= 0 && at(i) && counts[0] <= maxCount) { counts[0]++; i--; }
    if (counts[0] > maxCount) return NaN;

    i = (vertical ? startY : startX) + 1;
    while (i < limit && at(i) && counts[2] <= maxCount) { counts[2]++; i++; }
    if (i === limit || counts[2] > maxCount) return NaN;
    while (i < limit && !at(i) && counts[3] <= maxCount) { counts[3]++; i++; }
    if (i === limit || counts[3] > maxCount) return NaN;
    while (i < limit && at(i) && counts[4] <= maxCount) { counts[4]++; i++; }
    if (counts[4] > maxCount) return NaN;

    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (Math.abs(total - originalTotal) * 5 >= originalTotal * 2) return NaN;
    return checkRatio(counts) ? centerFromEnd(counts, i) : NaN;
  }

  function findFinders(matrix) {
    const found = [];

    const record = (x, y, moduleSize) => {
      for (const p of found) {
        if (Math.abs(p.x - x) < p.moduleSize && Math.abs(p.y - y) < p.moduleSize) {
          // Merge with an existing centre — running average keeps it stable.
          p.x = (p.x * p.count + x) / (p.count + 1);
          p.y = (p.y * p.count + y) / (p.count + 1);
          p.moduleSize = (p.moduleSize * p.count + moduleSize) / (p.count + 1);
          p.count++;
          return;
        }
      }
      found.push({ x, y, moduleSize, count: 1 });
    };

    // Scanning every 2nd row is plenty for camera-sized frames and ~2x faster.
    const rowStep = Math.max(1, Math.floor(matrix.height / 240));

    for (let y = 0; y < matrix.height; y += rowStep) {
      const counts = [0, 0, 0, 0, 0];
      let state = 0;
      for (let x = 0; x < matrix.width; x++) {
        const dark = matrix.get(x, y);
        if (dark) {
          if (state % 2 === 1) state++;                      // light -> dark
          counts[state]++;
        } else {
          if (state % 2 === 0) {
            if (state === 4) {
              // Completed a full 1:1:3:1:1 run.
              if (checkRatio(counts)) {
                const total = counts.reduce((a, b) => a + b, 0);
                const centerX = centerFromEnd(counts, x);
                const centerY = crossCheck(matrix, Math.round(centerX), y, counts[2] * 2, total, true);
                if (!Number.isNaN(centerY)) {
                  // Re-measure horizontally through the vertically-refined centre.
                  const refinedX = crossCheck(matrix, Math.round(centerX), Math.round(centerY), counts[2] * 2, total, false);
                  if (!Number.isNaN(refinedX)) record(refinedX, centerY, total / 7);
                }
              }
              // Shift the window: reuse the last two runs as the first two.
              counts[0] = counts[2]; counts[1] = counts[3];
              counts[2] = counts[4]; counts[3] = 1; counts[4] = 0;
              state = 3;
              continue;
            }
            state++;
          }
          counts[state]++;
        }
      }
    }

    // Keep only well-confirmed centres.
    return found.filter((p) => p.count >= 2);
  }

  /* ---- 3. Ordering + grid estimation ---- */

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** Z component of (C-B) x (A-B); its sign tells us the handedness. */
  const crossProductZ = (a, b, c) =>
    (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);

  /** Order three finder centres into { bottomLeft, topLeft, topRight }. */
  function orderFinders(patterns) {
    const [p0, p1, p2] = patterns;
    const d01 = distance(p0, p1);
    const d12 = distance(p1, p2);
    const d02 = distance(p0, p2);

    // The corner opposite the longest edge (the hypotenuse) is the top-left.
    let topLeft, a, c;
    if (d12 >= d01 && d12 >= d02) { topLeft = p0; a = p1; c = p2; }
    else if (d02 >= d12 && d02 >= d01) { topLeft = p1; a = p0; c = p2; }
    else { topLeft = p2; a = p0; c = p1; }

    if (crossProductZ(a, topLeft, c) < 0) { const t = a; a = c; c = t; }
    return { bottomLeft: a, topLeft, topRight: c };
  }

  /**
   * Walk from (fromX,fromY) toward (toX,toY) with Bresenham, counting the
   * black->white->black transition, and return the distance covered.
   * Returns NaN if the run never completes before the endpoint.
   */
  function blackWhiteBlackRun(matrix, fromX, fromY, toX, toY) {
    const steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
    if (steep) {
      let t;
      t = fromX; fromX = fromY; fromY = t;
      t = toX; toX = toY; toY = t;
    }

    const dx = Math.abs(toX - fromX);
    const dy = Math.abs(toY - fromY);
    let error = -dx / 2;
    const xstep = fromX < toX ? 1 : -1;
    const ystep = fromY < toY ? 1 : -1;

    // State 0/2 are the dark runs either side of the light run (state 1).
    let state = 0;
    const xLimit = toX + xstep;
    for (let x = fromX, y = fromY; x !== xLimit; x += xstep) {
      const realX = steep ? y : x;
      const realY = steep ? x : y;
      if ((state === 1) === (matrix.get(realX, realY) === 1)) {
        if (state === 2) return Math.hypot(x - fromX, y - fromY);
        state++;
      }
      error += dy;
      if (error > 0) {
        if (y === toY) break;
        y += ystep;
        error -= dx;
      }
    }
    // Ran to the edge mid-pattern; treat the endpoint as the transition.
    if (state === 2) return Math.hypot(toX + xstep - fromX, toY - fromY);
    return NaN;
  }

  /** Same run measured in both directions from the centre, so it spans 7 modules. */
  function blackWhiteBlackRunBothWays(matrix, fromX, fromY, toX, toY) {
    let result = blackWhiteBlackRun(matrix, fromX, fromY, toX, toY);

    // Mirror the ray through the centre, clipping to the image bounds.
    let scale = 1;
    let otherToX = fromX - (toX - fromX);
    if (otherToX < 0) {
      scale = fromX / (fromX - otherToX);
      otherToX = 0;
    } else if (otherToX >= matrix.width) {
      scale = (matrix.width - 1 - fromX) / (otherToX - fromX);
      otherToX = matrix.width - 1;
    }
    let otherToY = Math.floor(fromY - (toY - fromY) * scale);

    scale = 1;
    if (otherToY < 0) {
      scale = fromY / (fromY - otherToY);
      otherToY = 0;
    } else if (otherToY >= matrix.height) {
      scale = (matrix.height - 1 - fromY) / (otherToY - fromY);
      otherToY = matrix.height - 1;
    }
    otherToX = Math.floor(fromX + (otherToX - fromX) * scale);

    result += blackWhiteBlackRun(matrix, fromX, fromY, otherToX, otherToY);
    return result - 1;                                       // centre pixel counted twice
  }

  /**
   * Module size along the axis between two finder centres.
   *
   * Measuring along this axis rather than along image rows is what makes the
   * estimate rotation-invariant: a horizontal run through a finder tilted by
   * theta is longer by 1/cos(theta), which would skew the grid dimension.
   */
  function estimateModuleSize(matrix, a, b) {
    const ax = Math.round(a.x), ay = Math.round(a.y);
    const bx = Math.round(b.x), by = Math.round(b.y);
    const est1 = blackWhiteBlackRunBothWays(matrix, ax, ay, bx, by);
    const est2 = blackWhiteBlackRunBothWays(matrix, bx, by, ax, ay);
    if (Number.isNaN(est1)) return Number.isNaN(est2) ? NaN : est2 / 7;
    if (Number.isNaN(est2)) return est1 / 7;
    return (est1 + est2) / 14;                               // 7 modules across, measured twice
  }

  /**
   * Pick the three candidates that actually look like a QR's finder triple.
   * Sorting by hit-count alone lets a spurious blob outrank a real corner, so
   * score every combination on module-size agreement plus how close the three
   * sit to the right isosceles triangle the spec guarantees.
   */
  function selectBestFinders(candidates) {
    if (candidates.length < 3) return null;
    if (candidates.length === 3) return candidates;

    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < candidates.length - 2; i++) {
      for (let j = i + 1; j < candidates.length - 1; j++) {
        for (let k = j + 1; k < candidates.length; k++) {
          const trio = [candidates[i], candidates[j], candidates[k]];
          const sizes = trio.map((p) => p.moduleSize);
          const avg = (sizes[0] + sizes[1] + sizes[2]) / 3;
          if (avg <= 0) continue;
          const sizeSpread = Math.max(...sizes.map((s) => Math.abs(s - avg))) / avg;

          const { topLeft, topRight, bottomLeft } = orderFinders(trio);
          const legA = distance(topLeft, topRight);
          const legB = distance(topLeft, bottomLeft);
          const hyp = distance(topRight, bottomLeft);
          if (legA <= 0 || legB <= 0) continue;

          const legRatio = Math.abs(legA - legB) / Math.max(legA, legB);
          const hypRatio = Math.abs(hyp - Math.hypot(legA, legB)) / hyp;
          // Legs should also span a plausible number of modules for a QR.
          const modules = legA / avg;
          if (modules < 10 || modules > 175) continue;

          const score = sizeSpread * 2 + legRatio * 3 + hypRatio * 3;
          if (score < bestScore) { bestScore = score; best = trio; }
        }
      }
    }
    return best;
  }

  /** Fractional grid dimension implied by the finder geometry. */
  function rawDimension(topLeft, topRight, bottomLeft, moduleSize) {
    // Finder centres sit 3.5 modules in from each edge, so the centre-to-centre
    // span covers (dimension - 7) modules.
    const across = distance(topLeft, topRight) / moduleSize;
    const down = distance(topLeft, bottomLeft) / moduleSize;
    return (across + down) / 2 + 7;
  }

  /**
   * Candidate dimensions worth trying, nearest-first.
   *
   * Only 4k+17 is a legal QR dimension. Our module size carries a few percent
   * of quantization error, which is a sizeable fraction of the 4-module grid
   * quantum, so snapping to the single nearest legal value guesses wrong on
   * blurry or small codes. Instead we hand back the closest few and let the
   * Reed-Solomon stage decide: a wrong dimension simply fails to decode.
   */
  function candidateDimensions(raw) {
    const k = Math.round((raw - 17) / 4);
    const out = [];
    for (const delta of [0, 1, -1, 2, -2]) {
      const version = k + delta;
      if (version >= 1 && version <= 40) out.push(version * 4 + 17);
    }
    return out;
  }

  /** Look for a 1:1:1 dark-light-dark alignment pattern inside a region. */
  function findAlignment(matrix, estX, estY, moduleSize) {
    const span = Math.ceil(moduleSize * 4);
    const left = Math.max(0, Math.floor(estX - span));
    const right = Math.min(matrix.width - 1, Math.ceil(estX + span));
    const top = Math.max(0, Math.floor(estY - span));
    const bottom = Math.min(matrix.height - 1, Math.ceil(estY + span));
    if (right - left < moduleSize * 3 || bottom - top < moduleSize * 3) return null;

    const maxVariance = moduleSize / 2;
    const candidates = [];

    for (let y = top; y <= bottom; y++) {
      const counts = [0, 0, 0];
      let state = 0;
      for (let x = left; x <= right; x++) {
        const dark = matrix.get(x, y);
        if (state === 0) {
          if (dark) { counts[0]++; } else if (counts[0] > 0) { state = 1; counts[1]++; }
        } else if (state === 1) {
          if (!dark) { counts[1]++; } else { state = 2; counts[2]++; }
        } else {
          if (dark) {
            counts[2]++;
          } else {
            // Finished dark-light-dark; check the ratio.
            if (Math.abs(counts[0] - moduleSize) < maxVariance
              && Math.abs(counts[1] - moduleSize) < maxVariance
              && Math.abs(counts[2] - moduleSize) < maxVariance) {
              const centerX = x - counts[2] - counts[1] / 2;
              const centerY = verifyAlignmentVertical(matrix, Math.round(centerX), y, moduleSize, maxVariance);
              if (centerY != null) candidates.push({ x: centerX, y: centerY });
            }
            counts[0] = counts[2]; counts[1] = 1; counts[2] = 0;
            state = 1;
          }
        }
      }
    }

    if (!candidates.length) return null;
    // Whichever candidate sits closest to where we predicted it should be.
    candidates.sort((p, q) =>
      Math.hypot(p.x - estX, p.y - estY) - Math.hypot(q.x - estX, q.y - estY));
    return candidates[0];
  }

  function verifyAlignmentVertical(matrix, centerX, centerY, moduleSize, maxVariance) {
    const counts = [0, 0, 0];
    let y = centerY;
    while (y >= 0 && matrix.get(centerX, y) && counts[1] <= moduleSize) { counts[1]++; y--; }
    if (y < 0 || counts[1] > moduleSize) return null;
    while (y >= 0 && !matrix.get(centerX, y) && counts[0] <= moduleSize) { counts[0]++; y--; }
    if (counts[0] > moduleSize) return null;

    y = centerY + 1;
    while (y < matrix.height && matrix.get(centerX, y) && counts[1] <= moduleSize) { counts[1]++; y++; }
    if (y === matrix.height || counts[1] > moduleSize) return null;
    while (y < matrix.height && !matrix.get(centerX, y) && counts[2] <= moduleSize) { counts[2]++; y++; }
    if (counts[2] > moduleSize) return null;

    if (Math.abs(counts[0] - moduleSize) >= maxVariance
      || Math.abs(counts[1] - moduleSize) >= maxVariance
      || Math.abs(counts[2] - moduleSize) >= maxVariance) return null;

    return y - counts[2] - counts[1] / 2;
  }

  /* ---- 4. Perspective transform + grid sampling ---- */

  class PerspectiveTransform {
    constructor(a11, a21, a31, a12, a22, a32, a13, a23, a33) {
      Object.assign(this, { a11, a21, a31, a12, a22, a32, a13, a23, a33 });
    }

    transform(x, y) {
      const denominator = this.a13 * x + this.a23 * y + this.a33;
      return {
        x: (this.a11 * x + this.a21 * y + this.a31) / denominator,
        y: (this.a12 * x + this.a22 * y + this.a32) / denominator,
      };
    }

    times(other) {
      return new PerspectiveTransform(
        this.a11 * other.a11 + this.a21 * other.a12 + this.a31 * other.a13,
        this.a11 * other.a21 + this.a21 * other.a22 + this.a31 * other.a23,
        this.a11 * other.a31 + this.a21 * other.a32 + this.a31 * other.a33,
        this.a12 * other.a11 + this.a22 * other.a12 + this.a32 * other.a13,
        this.a12 * other.a21 + this.a22 * other.a22 + this.a32 * other.a23,
        this.a12 * other.a31 + this.a22 * other.a32 + this.a32 * other.a33,
        this.a13 * other.a11 + this.a23 * other.a12 + this.a33 * other.a13,
        this.a13 * other.a21 + this.a23 * other.a22 + this.a33 * other.a23,
        this.a13 * other.a31 + this.a23 * other.a32 + this.a33 * other.a33,
      );
    }

    buildAdjoint() {
      return new PerspectiveTransform(
        this.a22 * this.a33 - this.a23 * this.a32,
        this.a23 * this.a31 - this.a21 * this.a33,
        this.a21 * this.a32 - this.a22 * this.a31,
        this.a13 * this.a32 - this.a12 * this.a33,
        this.a11 * this.a33 - this.a13 * this.a31,
        this.a12 * this.a31 - this.a11 * this.a32,
        this.a12 * this.a23 - this.a13 * this.a22,
        this.a13 * this.a21 - this.a11 * this.a23,
        this.a11 * this.a22 - this.a12 * this.a21,
      );
    }

    static squareToQuadrilateral(x0, y0, x1, y1, x2, y2, x3, y3) {
      const dx3 = x0 - x1 + x2 - x3;
      const dy3 = y0 - y1 + y2 - y3;
      if (dx3 === 0 && dy3 === 0) {
        return new PerspectiveTransform(x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1);
      }
      const dx1 = x1 - x2, dx2 = x3 - x2;
      const dy1 = y1 - y2, dy2 = y3 - y2;
      const denominator = dx1 * dy2 - dx2 * dy1;
      const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
      const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
      return new PerspectiveTransform(
        x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0,
        y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0,
        a13, a23, 1,
      );
    }

    static quadrilateralToSquare(x0, y0, x1, y1, x2, y2, x3, y3) {
      return PerspectiveTransform
        .squareToQuadrilateral(x0, y0, x1, y1, x2, y2, x3, y3)
        .buildAdjoint();
    }

    static quadrilateralToQuadrilateral(
      x0, y0, x1, y1, x2, y2, x3, y3,
      x0p, y0p, x1p, y1p, x2p, y2p, x3p, y3p,
    ) {
      const qToS = PerspectiveTransform.quadrilateralToSquare(x0, y0, x1, y1, x2, y2, x3, y3);
      const sToQ = PerspectiveTransform.squareToQuadrilateral(x0p, y0p, x1p, y1p, x2p, y2p, x3p, y3p);
      return sToQ.times(qToS);
    }
  }

  /** Sample the binarized image on the module grid defined by `transform`. */
  function sampleGrid(matrix, dimension, transform) {
    const bits = new Uint8Array(dimension * dimension);
    for (let y = 0; y < dimension; y++) {
      for (let x = 0; x < dimension; x++) {
        const p = transform.transform(x + 0.5, y + 0.5);
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        if (px < 0 || py < 0 || px >= matrix.width || py >= matrix.height) return null;
        bits[y * dimension + x] = matrix.get(px, py);
      }
    }
    return {
      size: dimension,
      get: (x, y) => bits[y * dimension + x],
      flip: (x, y) => { bits[y * dimension + x] ^= 1; },
    };
  }

  /* ---- 5. Reed-Solomon decoding (GF(256), Euclidean algorithm) ---- */

  const GF = (() => {
    const exp = new Uint8Array(256);
    const log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 256; i++) {
      exp[i] = x;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
      x &= 0xff;
    }
    for (let i = 0; i < 255; i++) log[exp[i]] = i;

    const multiply = (a, b) => (a === 0 || b === 0 ? 0 : exp[(log[a] + log[b]) % 255]);
    const inverse = (a) => {
      if (a === 0) throw new Error('GF: no inverse of zero');
      return exp[255 - log[a]];
    };
    return { exp: (i) => exp[((i % 255) + 255) % 255], log: (a) => log[a], multiply, inverse };
  })();

  /** Polynomial over GF(256); coefficients are big-endian (index 0 = highest degree). */
  class Poly {
    constructor(coefficients) {
      let first = 0;
      while (first < coefficients.length - 1 && coefficients[first] === 0) first++;
      this.coefficients = coefficients.slice(first);
    }
    get degree() { return this.coefficients.length - 1; }
    get isZero() { return this.coefficients[0] === 0; }
    coefficient(degree) { return this.coefficients[this.coefficients.length - 1 - degree]; }

    evaluateAt(a) {
      if (a === 0) return this.coefficient(0);
      let result = this.coefficients[0];
      for (let i = 1; i < this.coefficients.length; i++) {
        result = GF.multiply(a, result) ^ this.coefficients[i];
      }
      return result;
    }

    addOrSubtract(other) {
      if (this.isZero) return other;
      if (other.isZero) return this;
      let smaller = this.coefficients;
      let larger = other.coefficients;
      if (smaller.length > larger.length) { const t = smaller; smaller = larger; larger = t; }
      const sumDiff = new Uint8Array(larger.length);
      const lengthDiff = larger.length - smaller.length;
      sumDiff.set(larger.subarray(0, lengthDiff));
      for (let i = lengthDiff; i < larger.length; i++) {
        sumDiff[i] = smaller[i - lengthDiff] ^ larger[i];
      }
      return new Poly(sumDiff);
    }

    multiplyPoly(other) {
      if (this.isZero || other.isZero) return new Poly(new Uint8Array([0]));
      const a = this.coefficients, b = other.coefficients;
      const product = new Uint8Array(a.length + b.length - 1);
      for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
          product[i + j] ^= GF.multiply(a[i], b[j]);
        }
      }
      return new Poly(product);
    }

    multiplyScalar(scalar) {
      if (scalar === 0) return new Poly(new Uint8Array([0]));
      if (scalar === 1) return this;
      const product = new Uint8Array(this.coefficients.length);
      for (let i = 0; i < product.length; i++) product[i] = GF.multiply(this.coefficients[i], scalar);
      return new Poly(product);
    }

    multiplyMonomial(degree, coefficient) {
      if (degree < 0) throw new Error('bad monomial');
      if (coefficient === 0) return new Poly(new Uint8Array([0]));
      const product = new Uint8Array(this.coefficients.length + degree);
      for (let i = 0; i < this.coefficients.length; i++) {
        product[i] = GF.multiply(this.coefficients[i], coefficient);
      }
      return new Poly(product);
    }

    divide(other) {
      if (other.isZero) throw new Error('divide by zero');
      let quotient = new Poly(new Uint8Array([0]));
      let remainder = this;
      const denominatorLeadingTerm = other.coefficient(other.degree);
      const inverseDenominatorLeadingTerm = GF.inverse(denominatorLeadingTerm);

      while (remainder.degree >= other.degree && !remainder.isZero) {
        const degreeDifference = remainder.degree - other.degree;
        const scale = GF.multiply(remainder.coefficient(remainder.degree), inverseDenominatorLeadingTerm);
        const term = other.multiplyMonomial(degreeDifference, scale);
        quotient = quotient.addOrSubtract(buildMonomial(degreeDifference, scale));
        remainder = remainder.addOrSubtract(term);
      }
      return [quotient, remainder];
    }
  }

  function buildMonomial(degree, coefficient) {
    if (coefficient === 0) return new Poly(new Uint8Array([0]));
    const coefficients = new Uint8Array(degree + 1);
    coefficients[0] = coefficient;
    return new Poly(coefficients);
  }

  function runEuclidean(a, b, R) {
    if (a.degree < b.degree) { const t = a; a = b; b = t; }
    let rLast = a, r = b;
    let tLast = new Poly(new Uint8Array([0]));
    let t = new Poly(new Uint8Array([1]));

    while (r.degree >= Math.floor(R / 2)) {
      const rLastLast = rLast;
      const tLastLast = tLast;
      rLast = r; tLast = t;
      if (rLast.isZero) throw new Error('RS: r_{i-1} was zero');

      r = rLastLast;
      let q = new Poly(new Uint8Array([0]));
      const denominatorLeadingTerm = rLast.coefficient(rLast.degree);
      const dltInverse = GF.inverse(denominatorLeadingTerm);
      while (r.degree >= rLast.degree && !r.isZero) {
        const degreeDiff = r.degree - rLast.degree;
        const scale = GF.multiply(r.coefficient(r.degree), dltInverse);
        q = q.addOrSubtract(buildMonomial(degreeDiff, scale));
        r = r.addOrSubtract(rLast.multiplyMonomial(degreeDiff, scale));
      }
      t = q.multiplyPoly(tLast).addOrSubtract(tLastLast);
      if (r.degree >= rLast.degree) throw new Error('RS: division algorithm failed');
    }

    const sigmaTildeAtZero = t.coefficient(0);
    if (sigmaTildeAtZero === 0) throw new Error('RS: sigmaTilde(0) was zero');
    const inv = GF.inverse(sigmaTildeAtZero);
    return [t.multiplyScalar(inv), r.multiplyScalar(inv)];
  }

  function findErrorLocations(errorLocator) {
    const numErrors = errorLocator.degree;
    if (numErrors === 1) return [errorLocator.coefficient(1)];
    const result = new Array(numErrors);
    let e = 0;
    for (let i = 1; i < 256 && e < numErrors; i++) {
      if (errorLocator.evaluateAt(i) === 0) result[e++] = GF.inverse(i);
    }
    if (e !== numErrors) throw new Error('RS: error locator degree does not match roots');
    return result;
  }

  function findErrorMagnitudes(errorEvaluator, errorLocations) {
    const s = errorLocations.length;
    const result = new Array(s);
    for (let i = 0; i < s; i++) {
      const xiInverse = GF.inverse(errorLocations[i]);
      let denominator = 1;
      for (let j = 0; j < s; j++) {
        if (i === j) continue;
        const term = GF.multiply(errorLocations[j], xiInverse);
        denominator = GF.multiply(denominator, (term & 1) === 0 ? term | 1 : term & ~1);
      }
      result[i] = GF.multiply(errorEvaluator.evaluateAt(xiInverse), GF.inverse(denominator));
    }
    return result;
  }

  /** In-place error correction. Throws if the block is beyond repair. */
  function rsDecode(received, twoS) {
    const poly = new Poly(Uint8Array.from(received));
    const syndromeCoefficients = new Uint8Array(twoS);
    let noError = true;
    for (let i = 0; i < twoS; i++) {
      const evaluated = poly.evaluateAt(GF.exp(i));
      syndromeCoefficients[twoS - 1 - i] = evaluated;
      if (evaluated !== 0) noError = false;
    }
    if (noError) return received;

    const syndrome = new Poly(syndromeCoefficients);
    const [sigma, omega] = runEuclidean(buildMonomial(twoS, 1), syndrome, twoS);
    const errorLocations = findErrorLocations(sigma);
    const errorMagnitudes = findErrorMagnitudes(omega, errorLocations);
    for (let i = 0; i < errorLocations.length; i++) {
      const position = received.length - 1 - GF.log(errorLocations[i]);
      if (position < 0 || position >= received.length) throw new Error('RS: bad error location');
      received[position] ^= errorMagnitudes[i];
    }
    return received;
  }

  /* ---- 6. Format / version info ---- */

  const FORMAT_INFO_DECODE_LOOKUP = [
    [0x5412, 0x00], [0x5125, 0x01], [0x5e7c, 0x02], [0x5b4b, 0x03],
    [0x45f9, 0x04], [0x40ce, 0x05], [0x4f97, 0x06], [0x4aa0, 0x07],
    [0x77c4, 0x08], [0x72f3, 0x09], [0x7daa, 0x0a], [0x789d, 0x0b],
    [0x662f, 0x0c], [0x6318, 0x0d], [0x6c41, 0x0e], [0x6976, 0x0f],
    [0x1689, 0x10], [0x13be, 0x11], [0x1ce7, 0x12], [0x19d0, 0x13],
    [0x0762, 0x14], [0x0255, 0x15], [0x0d0c, 0x16], [0x083b, 0x17],
    [0x355f, 0x18], [0x3068, 0x19], [0x3f31, 0x1a], [0x3a06, 0x1b],
    [0x24b4, 0x1c], [0x2183, 0x1d], [0x2eda, 0x1e], [0x2bed, 0x1f],
  ];

  // Maps the 2 format-info ECC bits to our ECC table index (L=0,M=1,Q=2,H=3).
  const FORMAT_ECC_TO_INDEX = [1, 0, 3, 2];

  const VERSION_DECODE_INFO = [
    0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d,
    0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9,
    0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75,
    0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64,
    0x27541, 0x28c69,
  ];

  const popCount = (n) => {
    let count = 0;
    while (n) { n &= n - 1; count++; }
    return count;
  };

  function decodeFormatInfo(rawA, rawB) {
    let best = null;
    let bestDistance = 4;                                    // reject anything worse
    for (const raw of [rawA, rawB]) {
      for (const [pattern, decoded] of FORMAT_INFO_DECODE_LOOKUP) {
        if (pattern === raw) return { ecc: FORMAT_ECC_TO_INDEX[decoded >> 3], mask: decoded & 7 };
        const d = popCount(raw ^ pattern);
        if (d < bestDistance) {
          bestDistance = d;
          best = { ecc: FORMAT_ECC_TO_INDEX[decoded >> 3], mask: decoded & 7 };
        }
      }
    }
    return best;
  }

  function decodeVersionInfo(raw) {
    let best = 0;
    let bestDistance = 4;
    for (let i = 0; i < VERSION_DECODE_INFO.length; i++) {
      const pattern = VERSION_DECODE_INFO[i];
      if (pattern === raw) return i + 7;
      const d = popCount(raw ^ pattern);
      if (d < bestDistance) { bestDistance = d; best = i + 7; }
    }
    return best || 0;
  }

  /* ---- 7. Bit matrix -> codewords ---- */

  /** Mark every function module (finders, timing, alignment, format, version). */
  function buildFunctionMask(version, dimension) {
    const mask = new Uint8Array(dimension * dimension);
    const setRegion = (x, y, w, h) => {
      for (let j = y; j < y + h; j++) {
        for (let i = x; i < x + w; i++) mask[j * dimension + i] = 1;
      }
    };

    setRegion(0, 0, 9, 9);                                   // top-left finder + format
    setRegion(dimension - 8, 0, 8, 9);                       // top-right finder + format
    setRegion(0, dimension - 8, 9, 8);                       // bottom-left finder + format

    const centers = QrEncoder.alignmentPatternPositions(version);
    const max = centers.length;
    for (let i = 0; i < max; i++) {
      for (let j = 0; j < max; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === max - 1) || (i === max - 1 && j === 0)) continue;
        setRegion(centers[j] - 2, centers[i] - 2, 5, 5);
      }
    }

    setRegion(6, 9, 1, dimension - 17);                      // vertical timing
    setRegion(9, 6, dimension - 17, 1);                      // horizontal timing

    if (version > 6) {
      setRegion(dimension - 11, 0, 3, 6);                    // version info, top-right
      setRegion(0, dimension - 11, 6, 3);                    // version info, bottom-left
    }
    return mask;
  }

  function readCodewords(grid, version, mask) {
    const dimension = grid.size;
    const functionMask = buildFunctionMask(version, dimension);

    // Undo the data mask on every non-function module.
    for (let y = 0; y < dimension; y++) {
      for (let x = 0; x < dimension; x++) {
        if (!functionMask[y * dimension + x] && QrEncoder.maskPredicate(mask, x, y)) {
          grid.flip(x, y);
        }
      }
    }

    const total = QrEncoder.numRawCodewords(version);
    const result = new Uint8Array(total);
    let bitIndex = 0;

    for (let right = dimension - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < dimension; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? dimension - 1 - vert : vert;
          if (functionMask[y * dimension + x]) continue;
          if (bitIndex >= total * 8) continue;
          result[bitIndex >>> 3] |= grid.get(x, y) << (7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
    return result;
  }

  /** Inverse of the encoder's interleave, then per-block error correction. */
  function deinterleaveAndCorrect(raw, version, ecc) {
    const numBlocks = QrEncoder.NUM_ECC_BLOCKS[ecc][version];
    const blockEccLen = QrEncoder.ECC_CODEWORDS_PER_BLOCK[ecc][version];
    const rawCodewords = QrEncoder.numRawCodewords(version);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const skipIndex = shortBlockLen - blockEccLen;           // the placeholder slot

    const blocks = [];
    for (let i = 0; i < numBlocks; i++) blocks.push(new Uint8Array(shortBlockLen + 1));

    let k = 0;
    for (let i = 0; i < shortBlockLen + 1; i++) {
      for (let j = 0; j < numBlocks; j++) {
        if (i === skipIndex && j < numShortBlocks) continue;
        blocks[j][i] = raw[k++];
      }
    }

    const out = [];
    for (let j = 0; j < numBlocks; j++) {
      let block = blocks[j];
      if (j < numShortBlocks) {
        // Drop the placeholder byte the encoder inserted.
        const trimmed = new Uint8Array(shortBlockLen);
        trimmed.set(block.subarray(0, skipIndex));
        trimmed.set(block.subarray(skipIndex + 1), skipIndex);
        block = trimmed;
      }
      rsDecode(block, blockEccLen);
      out.push(...block.subarray(0, block.length - blockEccLen));
    }
    return Uint8Array.from(out);
  }

  /* ---- 8. Bitstream -> text ---- */

  const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  class BitReader {
    constructor(bytes) { this.bytes = bytes; this.bitPos = 0; }
    get available() { return this.bytes.length * 8 - this.bitPos; }
    read(n) {
      if (n > this.available) throw new Error('QR: bitstream underrun');
      let result = 0;
      for (let i = 0; i < n; i++) {
        const byte = this.bytes[this.bitPos >>> 3];
        result = (result << 1) | ((byte >>> (7 - (this.bitPos & 7))) & 1);
        this.bitPos++;
      }
      return result;
    }
  }

  function parseBitstream(bytes, version) {
    const reader = new BitReader(bytes);
    const out = [];
    const charCountBits = (mode) => {
      const table = {
        1: [10, 12, 14],                                     // numeric
        2: [9, 11, 13],                                      // alphanumeric
        4: [8, 16, 16],                                      // byte
        8: [8, 10, 12],                                      // kanji
      }[mode];
      if (!table) return 0;
      return version <= 9 ? table[0] : version <= 26 ? table[1] : table[2];
    };

    while (reader.available >= 4) {
      const mode = reader.read(4);
      if (mode === 0) break;                                 // terminator

      if (mode === 7) { reader.read(8); continue; }          // ECI — assume UTF-8 anyway

      const count = reader.read(charCountBits(mode));

      if (mode === 4) {
        for (let i = 0; i < count; i++) out.push(reader.read(8));
      } else if (mode === 1) {
        let i = 0;
        for (; i + 3 <= count; i += 3) {
          const v = reader.read(10);
          out.push(48 + Math.floor(v / 100), 48 + Math.floor(v / 10) % 10, 48 + (v % 10));
        }
        if (count - i === 2) {
          const v = reader.read(7);
          out.push(48 + Math.floor(v / 10), 48 + (v % 10));
        } else if (count - i === 1) {
          out.push(48 + reader.read(4));
        }
      } else if (mode === 2) {
        let i = 0;
        for (; i + 2 <= count; i += 2) {
          const v = reader.read(11);
          out.push(ALPHANUMERIC.charCodeAt(Math.floor(v / 45)), ALPHANUMERIC.charCodeAt(v % 45));
        }
        if (count - i === 1) out.push(ALPHANUMERIC.charCodeAt(reader.read(6)));
      } else {
        throw new Error(`QR: unsupported mode ${mode}`);
      }
    }

    return new TextDecoder('utf-8').decode(Uint8Array.from(out));
  }

  /* ---- 9. Top-level decode ---- */

  /**
   * Attempt to read a QR code from an ImageData.
   * @returns {string|null} decoded text, or null if nothing legible was found.
   */
  /** One decode attempt at a specific assumed grid dimension. */
  function attemptDecode(matrix, topLeft, topRight, bottomLeft, moduleSize, dimension) {
    const provisionalVersion = (dimension - 17) / 4;

    // For version >= 2, locate the bottom-right alignment pattern so the
    // perspective transform has a real fourth point instead of a guess.
    let alignment = null;
    if (provisionalVersion >= 2) {
      const bottomRightX = topRight.x - topLeft.x + bottomLeft.x;
      const bottomRightY = topRight.y - topLeft.y + bottomLeft.y;
      const correction = 1 - 3 / (dimension - 7);
      const estX = topLeft.x + correction * (bottomRightX - topLeft.x);
      const estY = topLeft.y + correction * (bottomRightY - topLeft.y);
      alignment = findAlignment(matrix, estX, estY, moduleSize);
    }

    const dimMinusThree = dimension - 3.5;
    let bottomRightXModule, bottomRightYModule, sourceBottomRightX, sourceBottomRightY;
    if (alignment) {
      bottomRightXModule = dimension - 6.5;
      bottomRightYModule = dimension - 6.5;
      sourceBottomRightX = alignment.x;
      sourceBottomRightY = alignment.y;
    } else {
      bottomRightXModule = dimension - 3.5;
      bottomRightYModule = dimension - 3.5;
      sourceBottomRightX = topRight.x - topLeft.x + bottomLeft.x;
      sourceBottomRightY = topRight.y - topLeft.y + bottomLeft.y;
    }

    const transform = PerspectiveTransform.quadrilateralToQuadrilateral(
      3.5, 3.5,
      dimMinusThree, 3.5,
      bottomRightXModule, bottomRightYModule,
      3.5, dimMinusThree,
      topLeft.x, topLeft.y,
      topRight.x, topRight.y,
      sourceBottomRightX, sourceBottomRightY,
      bottomLeft.x, bottomLeft.y,
    );

    const grid = sampleGrid(matrix, dimension, transform);
    if (!grid) return null;

    // Format info, copy 1: around the top-left finder.
    let formatA = 0;
    for (let i = 0; i < 6; i++) formatA = (formatA << 1) | grid.get(i, 8);
    formatA = (formatA << 1) | grid.get(7, 8);
    formatA = (formatA << 1) | grid.get(8, 8);
    formatA = (formatA << 1) | grid.get(8, 7);
    for (let i = 5; i >= 0; i--) formatA = (formatA << 1) | grid.get(8, i);

    // Format info, copy 2: split across the other two finders.
    let formatB = 0;
    for (let i = dimension - 1; i >= dimension - 7; i--) formatB = (formatB << 1) | grid.get(8, i);
    for (let i = dimension - 8; i < dimension; i++) formatB = (formatB << 1) | grid.get(i, 8);

    const format = decodeFormatInfo(formatA, formatB);
    if (!format) return null;

    // Version 7+ carries an explicit version block; trust it over the estimate.
    let version = provisionalVersion;
    if (provisionalVersion >= 7) {
      let versionBits = 0;
      for (let i = 5; i >= 0; i--) {
        for (let j = dimension - 9; j >= dimension - 11; j--) {
          versionBits = (versionBits << 1) | grid.get(j, i);
        }
      }
      const decoded = decodeVersionInfo(versionBits);
      if (decoded && decoded * 4 + 17 === dimension) version = decoded;
    }

    const raw = readCodewords(grid, version, format.mask);
    const data = deinterleaveAndCorrect(raw, version, format.ecc);
    return parseBitstream(data, version) || null;
  }

  function decode(imageData) {
    let matrix;
    let trio;
    let moduleSize;
    try {
      matrix = binarize(imageData);
      const finders = findFinders(matrix);
      if (finders.length < 3) return null;

      // Keep the strongest candidates, then choose the trio with the best
      // finder-triangle geometry among them.
      finders.sort((a, b) => b.count - a.count);
      trio = selectBestFinders(finders.slice(0, 8));
      if (!trio) return null;

      const ordered = orderFinders(trio);
      const sizeAcross = estimateModuleSize(matrix, ordered.topLeft, ordered.topRight);
      const sizeDown = estimateModuleSize(matrix, ordered.topLeft, ordered.bottomLeft);
      moduleSize = Number.isNaN(sizeAcross) ? sizeDown
        : Number.isNaN(sizeDown) ? sizeAcross
          : (sizeAcross + sizeDown) / 2;
      if (!(moduleSize >= 1)) return null;
      trio = ordered;
    } catch {
      return null;
    }

    const raw = rawDimension(trio.topLeft, trio.topRight, trio.bottomLeft, moduleSize);
    if (!Number.isFinite(raw)) return null;

    // Reed-Solomon is a strong validator, so an incorrect dimension throws
    // rather than returning plausible-but-wrong text. That lets us simply try
    // the nearest legal dimensions in order and keep the first that decodes.
    for (const dimension of candidateDimensions(raw)) {
      try {
        const text = attemptDecode(matrix, trio.topLeft, trio.topRight, trio.bottomLeft, moduleSize, dimension);
        if (text) return text;
      } catch {
        // This dimension was wrong; fall through to the next candidate.
      }
    }
    return null;
  }

  return { decode };
})();

/* ==========================================================================
   Scanner — camera capture + decode loop
   ========================================================================== */
const Scanner = (() => {
  let stream = null;
  let rafId = 0;
  let detector = null;
  let running = false;

  const video = () => document.getElementById('scanVideo');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const isSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  /** Prefer the platform decoder where it exists; fall back to ours. */
  async function initDetector() {
    if (detector !== null) return detector;
    try {
      if ('BarcodeDetector' in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return detector;
        }
      }
    } catch { /* fall through */ }
    detector = false;
    return detector;
  }

  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  async function start({ deviceId, onResult, onStatus } = {}) {
    if (!isSupported()) throw new Error('This browser has no camera access. Paste the code instead.');

    await stop();
    await initDetector();

    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 1280 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Retry without the rear-camera hint — some laptops only have one camera.
      if (!deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw describeCameraError(err);
      }
    }

    const v = video();
    v.srcObject = stream;
    await v.play();

    running = true;
    onStatus?.('Point the camera at the code.');

    let lastScan = 0;
    const tick = async (now) => {
      if (!running) return;
      // ~12 fps is plenty and keeps phones from cooking.
      if (now - lastScan > 80 && v.readyState >= 2) {
        lastScan = now;
        const text = await scanFrame(v);
        if (text) {
          onResult?.(text);
          return;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  async function scanFrame(v) {
    // Native path — much faster and handles odd angles well.
    if (detector) {
      try {
        const codes = await detector.detect(v);
        if (codes.length && codes[0].rawValue) return codes[0].rawValue;
        return null;
      } catch {
        detector = false;                                    // fall back permanently
      }
    }

    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return null;

    // Downscale to keep the decode cheap; crop to the central square, which is
    // what the on-screen reticle tells the user to aim with.
    const side = Math.min(vw, vh);
    const target = Math.min(480, side);
    canvas.width = target;
    canvas.height = target;
    ctx.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, target, target);

    const imageData = ctx.getImageData(0, 0, target, target);
    return QrDecoder.decode(imageData);
  }

  async function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    const v = video();
    if (v) v.srcObject = null;
  }

  function describeCameraError(err) {
    switch (err?.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return new Error('Camera access was blocked. Allow it in your browser settings, or paste the code instead.');
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return new Error('No camera found on this device. Paste the code instead.');
      case 'NotReadableError':
        return new Error('The camera is already in use by another app.');
      default:
        return new Error('Could not start the camera. Paste the code instead.');
    }
  }

  return { start, stop, listCameras, isSupported };
})();

/* ==========================================================================
   Signal — SDP <-> compact handshake token

   A browser's SDP offer is ~3 KB, mostly boilerplate that both peers already
   agree on. We keep only what genuinely varies (ICE credentials, the DTLS
   fingerprint, the candidate list) and rebuild a canonical SDP on the far
   side. Deflating the result gets a typical offer to ~250-400 characters.
   ========================================================================== */
const Signal = (() => {
  const PREFIX_DEFLATE = 'B1';
  const PREFIX_PLAIN = 'B0';

  const SETUP_CODES = ['actpass', 'active', 'passive'];
  const CAND_TYPES = { h: 'host', s: 'srflx', r: 'relay' };
  const CAND_CODES = { host: 'h', srflx: 's', relay: 'r' };

  // Typed priorities; the exact values only affect candidate ordering.
  const PRIORITIES = { host: 2130706431, srflx: 1694498815, relay: 16777215 };

  const match = (sdp, re) => {
    const m = sdp.match(re);
    return m ? m[1].trim() : null;
  };

  /** Pull the fields we care about out of a real SDP. */
  function parseSdp(sdp, type) {
    const ufrag = match(sdp, /^a=ice-ufrag:(.+)$/m);
    const pwd = match(sdp, /^a=ice-pwd:(.+)$/m);
    const fingerprintHex = match(sdp, /^a=fingerprint:sha-256 (.+)$/mi);
    const setup = match(sdp, /^a=setup:(\w+)$/m) || 'actpass';
    const sctpPort = match(sdp, /^a=sctp-port:(\d+)$/m) || '5000';
    const maxMessageSize = match(sdp, /^a=max-message-size:(\d+)$/m) || '262144';

    if (!ufrag || !pwd || !fingerprintHex) {
      throw new Error('This browser produced an SDP we cannot compact.');
    }

    const fpBytes = Uint8Array.from(
      fingerprintHex.split(':').map((h) => parseInt(h, 16)),
    );
    if (fpBytes.length !== 32 || fpBytes.some(Number.isNaN)) {
      throw new Error('Unexpected DTLS fingerprint format.');
    }

    const candidates = [];
    const seen = new Set();
    const re = /^a=candidate:(.+)$/gm;
    let m;
    while ((m = re.exec(sdp)) !== null) {
      const parts = m[1].split(' ');
      const [, component, transport, , ip, port] = parts;
      const typIndex = parts.indexOf('typ');
      const candType = typIndex >= 0 ? parts[typIndex + 1] : null;

      // Only component 1 UDP host/srflx/relay candidates survive the trip;
      // TCP candidates are rarely the winning pair and cost QR real estate.
      if (component !== '1') continue;
      if (transport.toLowerCase() !== 'udp') continue;
      if (!CAND_CODES[candType]) continue;

      const key = `${candType}|${ip}|${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(`${CAND_CODES[candType]}${ip}:${port}`);
    }

    if (!candidates.length) {
      throw new Error('No usable network candidates were gathered. Check your connection and try again.');
    }

    return [
      type === 'offer' ? 0 : 1,
      ufrag,
      pwd,
      Util.bytesToBase64(fpBytes),
      Math.max(0, SETUP_CODES.indexOf(setup)),
      Number(sctpPort),
      Number(maxMessageSize),
      candidates,
    ];
  }

  /** Rebuild a canonical, browser-acceptable SDP from the compact form. */
  function buildSdp(compact) {
    const [typeCode, ufrag, pwd, fpB64, setupCode, sctpPort, maxMessageSize, candidates] = compact;

    const fpBytes = Util.base64ToBytes(fpB64);
    const fpHex = Array.from(fpBytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(':');

    const lines = [
      'v=0',
      'o=- 1234567890123456789 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
    ];

    candidates.forEach((c, i) => {
      const type = CAND_TYPES[c[0]];
      const rest = c.slice(1);
      const sep = rest.lastIndexOf(':');
      const ip = rest.slice(0, sep);
      const port = rest.slice(sep + 1);
      const isIpv6 = ip.includes(':');
      let line = `a=candidate:${i + 1} 1 udp ${PRIORITIES[type]} ${ip} ${port} typ ${type}`;
      if (type !== 'host') {
        // raddr/rport are informational for the remote peer; zeros are accepted.
        line += isIpv6 ? ' raddr :: rport 0' : ' raddr 0.0.0.0 rport 0';
      }
      lines.push(line + ' generation 0');
    });

    lines.push(
      'a=end-of-candidates',
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${fpHex}`,
      `a=setup:${SETUP_CODES[setupCode] || 'actpass'}`,
      'a=mid:0',
      'a=sctp-port:' + (sctpPort || 5000),
      'a=max-message-size:' + (maxMessageSize || 262144),
    );

    return {
      type: typeCode === 0 ? 'offer' : 'answer',
      sdp: lines.join('\r\n') + '\r\n',
    };
  }

  /* ---- compression ---- */

  const hasCompression = () =>
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

  async function deflate(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  /* ---- public API ---- */

  /** RTCSessionDescription -> short shareable token. */
  async function encode(description) {
    const compact = parseSdp(description.sdp, description.type);
    const json = JSON.stringify(compact);
    if (hasCompression()) {
      try {
        return PREFIX_DEFLATE + Util.bytesToBase64Url(await deflate(json));
      } catch { /* fall through to the plain encoding */ }
    }
    return PREFIX_PLAIN + Util.bytesToBase64Url(new TextEncoder().encode(json));
  }

  /** Token -> {type, sdp}. Throws a user-facing Error on malformed input. */
  async function decode(token) {
    const trimmed = String(token || '').trim().replace(/\s+/g, '');
    if (!trimmed) throw new Error('Nothing to read — the code is empty.');

    const prefix = trimmed.slice(0, 2);
    const body = trimmed.slice(2);

    if (prefix !== PREFIX_DEFLATE && prefix !== PREFIX_PLAIN) {
      throw new Error("That doesn't look like a Beam code. Make sure you copied the whole thing.");
    }

    let json;
    try {
      const bytes = Util.base64UrlToBytes(body);
      json = prefix === PREFIX_DEFLATE
        ? await inflate(bytes)
        : new TextDecoder().decode(bytes);
    } catch {
      throw new Error('That code looks damaged or incomplete. Try copying it again.');
    }

    let compact;
    try {
      compact = JSON.parse(json);
    } catch {
      throw new Error('That code looks damaged or incomplete. Try copying it again.');
    }

    if (!Array.isArray(compact) || compact.length !== 8 || !Array.isArray(compact[7])) {
      throw new Error('That code is not in a format this version understands.');
    }

    return buildSdp(compact);
  }

  return { encode, decode };
})();

/* ==========================================================================
   Peer — RTCPeerConnection lifecycle
   ========================================================================== */
const Peer = (() => {
  // Public STUN only. It learns your public IP:port so two devices on
  // different networks can find each other — it never sees file data, and
  // LAN-to-LAN transfers work even if it is unreachable.
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const GATHER_TIMEOUT_MS = 4000;

  class Connection {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 0 });
      this.channel = null;
      this.closed = false;

      this.pc.addEventListener('iceconnectionstatechange', () => this._onIceStateChange());
      this.pc.addEventListener('connectionstatechange', () => this._onConnStateChange());
      this.pc.addEventListener('datachannel', (event) => this._bindChannel(event.channel));
    }

    _onIceStateChange() {
      const state = this.pc.iceConnectionState;
      if (state === 'failed') {
        this.handlers.onError?.(new Error(
          'Could not open a direct connection. The two devices may be on networks that block peer-to-peer traffic.',
        ));
      } else if (state === 'disconnected') {
        this.handlers.onStatus?.('connecting');
      }
    }

    _onConnStateChange() {
      const state = this.pc.connectionState;
      if (state === 'connecting') this.handlers.onStatus?.('connecting');
      if (state === 'failed') {
        this.handlers.onError?.(new Error('The connection failed. Start over and exchange a fresh code.'));
      }
      if (state === 'closed' && !this.closed) {
        this.handlers.onClose?.();
      }
    }

    _bindChannel(channel) {
      this.channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('open', () => this.handlers.onOpen?.(channel));
      channel.addEventListener('message', (event) => this.handlers.onMessage?.(event.data));
      channel.addEventListener('close', () => {
        if (!this.closed) this.handlers.onClose?.();
      });
      channel.addEventListener('error', (event) => {
        // A close during an in-flight send surfaces here; it's not always fatal.
        if (this.closed) return;
        const err = event.error;
        if (err && err.name !== 'OperationError') {
          this.handlers.onError?.(new Error('The data channel reported an error. The connection may have dropped.'));
        }
      });
    }

    /** Sender side: create the channel, then the offer token. */
    async createOffer() {
      const channel = this.pc.createDataChannel('beam', { ordered: true });
      this._bindChannel(channel);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this._waitForGathering();
      return Signal.encode(this.pc.localDescription);
    }

    /** Receiver side: consume the offer token, return an answer token. */
    async acceptOfferAndAnswer(token) {
      const description = await Signal.decode(token);
      if (description.type !== 'offer') {
        throw new Error('That is a reply code, not an invite. Ask the sender for their invite code.');
      }
      await this.pc.setRemoteDescription(description);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this._waitForGathering();
      return Signal.encode(this.pc.localDescription);
    }

    /** Sender side: consume the answer token. */
    async acceptAnswer(token) {
      const description = await Signal.decode(token);
      if (description.type !== 'answer') {
        throw new Error('That is an invite code, not a reply. Ask the other device for its reply code.');
      }
      if (this.pc.signalingState !== 'have-local-offer') {
        throw new Error('This connection has already been used. Start over to link again.');
      }
      await this.pc.setRemoteDescription(description);
    }

    /**
     * Wait for ICE gathering. We cap the wait: a STUN server that is slow or
     * blocked shouldn't stop us handing over the LAN candidates we already have.
     */
    _waitForGathering() {
      return new Promise((resolve) => {
        if (this.pc.iceGatheringState === 'complete') return resolve();
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        };
        const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, GATHER_TIMEOUT_MS);
        this.pc.addEventListener('icegatheringstatechange', check);
      });
    }

    close() {
      this.closed = true;
      try { this.channel?.close(); } catch { /* already gone */ }
      try { this.pc.close(); } catch { /* already gone */ }
    }
  }

  /** Feature check with a specific message for the user. */
  function checkSupport() {
    if (typeof RTCPeerConnection === 'undefined') {
      return 'This browser does not support WebRTC, so peer-to-peer transfers are not possible. Try the latest Chrome, Edge, Firefox, or Safari.';
    }
    if (typeof RTCPeerConnection.prototype.createDataChannel !== 'function') {
      return 'This browser supports WebRTC but not data channels, which Beam needs to move files.';
    }
    if (typeof File === 'undefined' || typeof Blob.prototype.arrayBuffer !== 'function') {
      return 'This browser is missing the File APIs Beam needs. Try a newer version.';
    }
    return null;
  }

  return { Connection, checkSupport };
})();

/* ==========================================================================
   Transfer — chunked send/receive with backpressure
   ========================================================================== */
const Transfer = (() => {
  // 16 KB is the largest chunk every browser accepts on an SCTP data channel.
  const CHUNK_SIZE = 16 * 1024;
  // Keep roughly 1 MB in flight; pause when we exceed it, resume at 256 KB.
  const BUFFER_HIGH = 1024 * 1024;
  const BUFFER_LOW = 256 * 1024;
  // Coalesce received chunks into a Blob every 8 MB so the JS heap stays flat
  // on multi-hundred-MB files — Blob parts are backed by browser storage.
  const COALESCE_BYTES = 8 * 1024 * 1024;

  const MSG = {
    START: 'file-start',
    END: 'file-end',
    ACK: 'file-ack',
    CANCEL: 'cancel',
    DONE: 'all-done',
  };

  /** Exponential moving average of throughput, plus an ETA. */
  class RateMeter {
    constructor() {
      this.bytes = 0;
      this.lastBytes = 0;
      this.lastTime = performance.now();
      this.speed = 0;
    }
    update(totalBytes) {
      const now = performance.now();
      const elapsed = (now - this.lastTime) / 1000;
      if (elapsed < 0.25) return this.speed;
      const instant = (totalBytes - this.lastBytes) / elapsed;
      // Smooth hard so the readout doesn't jitter with SCTP's bursty pacing.
      this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
      this.lastBytes = totalBytes;
      this.lastTime = now;
      return this.speed;
    }
    eta(remaining) {
      return this.speed > 0 ? remaining / this.speed : Infinity;
    }
  }

  /* ---- Sender ---- */

  class Sender {
    constructor(channel, handlers = {}) {
      this.channel = channel;
      this.handlers = handlers;
      this.cancelled = false;
      this.active = false;
      this.pendingAcks = new Map();
      channel.bufferedAmountLowThreshold = BUFFER_LOW;
    }

    /** Resolve once the outgoing buffer has drained below the low-water mark. */
    _waitForDrain() {
      if (this.channel.bufferedAmount < BUFFER_HIGH) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onLow = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('The connection closed mid-transfer.'));
        };
        const cleanup = () => {
          this.channel.removeEventListener('bufferedamountlow', onLow);
          this.channel.removeEventListener('close', onClose);
          clearInterval(poll);
        };
        // Safari has historically been unreliable about firing this event, so
        // poll as a safety net rather than stalling forever.
        const poll = setInterval(() => {
          if (this.channel.readyState !== 'open') onClose();
          else if (this.channel.bufferedAmount < BUFFER_LOW) onLow();
        }, 100);
        this.channel.addEventListener('bufferedamountlow', onLow);
        this.channel.addEventListener('close', onClose);
      });
    }

    _send(obj) {
      if (this.channel.readyState !== 'open') throw new Error('The connection closed mid-transfer.');
      this.channel.send(JSON.stringify(obj));
    }

    handleMessage(data) {
      if (typeof data !== 'string') return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === MSG.ACK) {
        this.pendingAcks.get(msg.id)?.();
        this.pendingAcks.delete(msg.id);
      } else if (msg.type === MSG.CANCEL) {
        this.cancelled = true;
        this.handlers.onRemoteCancel?.();
      }
    }

    cancel() {
      this.cancelled = true;
      try { this._send({ type: MSG.CANCEL }); } catch { /* channel already gone */ }
    }

    /**
     * Send every file in `items` sequentially.
     * @param {Array<{id:string,file:File}>} items
     */
    async sendAll(items) {
      this.active = true;
      try {
        for (const item of items) {
          if (this.cancelled) break;
          await this._sendOne(item);
        }
        if (!this.cancelled) {
          try { this._send({ type: MSG.DONE }); } catch { /* best effort */ }
        }
      } finally {
        this.active = false;
      }
    }

    async _sendOne({ id, file }) {
      const meter = new RateMeter();
      this.handlers.onProgress?.(id, { sent: 0, total: file.size, speed: 0, eta: Infinity, state: 'active' });

      this._send({
        type: MSG.START,
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      });

      let offset = 0;
      while (offset < file.size) {
        if (this.cancelled) {
          this.handlers.onProgress?.(id, { sent: offset, total: file.size, state: 'cancelled' });
          return;
        }

        await this._waitForDrain();
        if (this.cancelled) return;

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        let buffer;
        try {
          buffer = await slice.arrayBuffer();
        } catch {
          throw new Error(`Could not read "${file.name}". It may have been moved or changed since you picked it.`);
        }

        // The channel can close between the drain check and here, so treat a
        // failed send as a dropped connection rather than leaking a DOM error.
        if (this.channel.readyState !== 'open') {
          throw new Error('The connection closed mid-transfer.');
        }
        try {
          this.channel.send(buffer);
        } catch {
          throw new Error('The connection closed mid-transfer.');
        }
        offset += buffer.byteLength;

        const speed = meter.update(offset);
        this.handlers.onProgress?.(id, {
          sent: offset,
          total: file.size,
          speed,
          eta: meter.eta(file.size - offset),
          state: 'active',
        });
      }

      this._send({ type: MSG.END, id });

      // Wait for the receiver to confirm it assembled the whole file.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30000);            // don't hang forever
        this.pendingAcks.set(id, () => { clearTimeout(timer); resolve(); });
      });

      if (!this.cancelled) {
        this.handlers.onProgress?.(id, { sent: file.size, total: file.size, speed: 0, eta: 0, state: 'done' });
        this.handlers.onFileComplete?.(id);
      }
    }
  }

  /* ---- Receiver ---- */

  class Receiver {
    constructor(channel, handlers = {}) {
      this.channel = channel;
      this.handlers = handlers;
      this.current = null;
      this.cancelled = false;
    }

    _send(obj) {
      if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(obj));
    }

    cancel() {
      this.cancelled = true;
      if (this.current) {
        this.handlers.onProgress?.(this.current.id, {
          received: this.current.received,
          total: this.current.size,
          state: 'cancelled',
        });
        this.current = null;
      }
      try { this._send({ type: MSG.CANCEL }); } catch { /* already gone */ }
    }

    handleMessage(data) {
      if (typeof data === 'string') this._handleControl(data);
      else this._handleChunk(data);
    }

    _handleControl(text) {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }

      switch (msg.type) {
        case MSG.START: {
          // Validate before trusting anything the peer told us.
          const size = Number(msg.size);
          if (!Number.isFinite(size) || size < 0) return;
          this.current = {
            id: String(msg.id),
            name: Util.sanitizeFilename(msg.name),
            size,
            mime: typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream',
            received: 0,
            pending: [],
            pendingBytes: 0,
            blobParts: [],
            meter: new RateMeter(),
          };
          this.handlers.onFileStart?.(this.current.id, {
            name: this.current.name,
            size: this.current.size,
          });
          break;
        }

        case MSG.END: {
          const file = this.current;
          if (!file || file.id !== String(msg.id)) return;
          this._flush(file);
          const blob = new Blob(file.blobParts, { type: file.mime });
          this.current = null;

          if (blob.size !== file.size) {
            this.handlers.onProgress?.(file.id, {
              received: blob.size,
              total: file.size,
              state: 'error',
            });
            this.handlers.onError?.(new Error(
              `"${file.name}" arrived incomplete (${Util.formatBytes(blob.size)} of ${Util.formatBytes(file.size)}).`,
            ));
            return;
          }

          this._send({ type: MSG.ACK, id: file.id });
          this.handlers.onProgress?.(file.id, {
            received: file.size, total: file.size, speed: 0, eta: 0, state: 'done',
          });
          this.handlers.onFileComplete?.(file.id, blob, file.name);
          break;
        }

        case MSG.CANCEL:
          this.cancelled = true;
          if (this.current) {
            this.handlers.onProgress?.(this.current.id, {
              received: this.current.received,
              total: this.current.size,
              state: 'cancelled',
            });
            this.current = null;
          }
          this.handlers.onRemoteCancel?.();
          break;

        case MSG.DONE:
          this.handlers.onAllDone?.();
          break;

        default:
          break;
      }
    }

    _handleChunk(data) {
      const file = this.current;
      if (!file || this.cancelled) return;                   // stray chunk — ignore

      const buffer = data instanceof ArrayBuffer ? data : null;
      if (!buffer) return;

      file.pending.push(buffer);
      file.pendingBytes += buffer.byteLength;
      file.received += buffer.byteLength;

      if (file.pendingBytes >= COALESCE_BYTES) this._flush(file);

      const speed = file.meter.update(file.received);
      this.handlers.onProgress?.(file.id, {
        received: file.received,
        total: file.size,
        speed,
        eta: file.meter.eta(file.size - file.received),
        state: 'active',
      });
    }

    /** Move buffered chunks into a Blob part, releasing heap memory. */
    _flush(file) {
      if (!file.pending.length) return;
      file.blobParts.push(new Blob(file.pending));
      file.pending = [];
      file.pendingBytes = 0;
    }
  }

  return { Sender, Receiver };
})();

/* ==========================================================================
   App — UI wiring
   ========================================================================== */
const App = (() => {
  const { $, el } = Util;

  const state = {
    connection: null,
    sender: null,
    receiver: null,
    files: [],           // {id, file}
    rows: new Map(),     // id -> {root, fill, stateEl, stats, actions}
    objectUrls: [],
    scanTarget: null,
  };

  let fileSeq = 0;

  /* ---- status pill ---- */

  const STATUS_LABELS = {
    idle: 'Ready',
    waiting: 'Waiting…',
    connecting: 'Connecting…',
    connected: 'Connected',
    sending: 'Sending…',
    receiving: 'Receiving…',
    complete: 'Complete',
    error: 'Disconnected',
  };

  function setStatus(key) {
    const pill = $('#statusPill');
    const text = $('#statusText');
    if (!pill || !text) return;
    pill.dataset.state = key === 'receiving' ? 'sending' : key;
    text.textContent = STATUS_LABELS[key] || key;
  }

  /* ---- navigation ---- */

  function show(screenId) {
    ['#screen-home', '#screen-send', '#screen-receive'].forEach((id) => {
      const node = $(id);
      if (node) node.hidden = id !== screenId;
    });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function goHome() {
    teardown();
    show('#screen-home');
    setStatus('idle');
  }

  /** Drop the connection and reset all per-session UI. */
  function teardown() {
    state.connection?.close();
    state.connection = null;
    state.sender = null;
    state.receiver = null;

    state.objectUrls.forEach(URL.revokeObjectURL);
    state.objectUrls = [];
    state.rows.clear();

    state.files = [];
    renderFileList();

    // Reset the send screen.
    $('#sendStageStart').hidden = false;
    $('#sendStageOffer').hidden = true;
    $('#sendStageLinked').hidden = true;
    $('#sendTransferPanel').hidden = true;
    $('#sendTransfers').textContent = '';
    $('#offerText').value = '';
    $('#answerText').value = '';
    $('#cancelSendBtn').hidden = true;
    $('#createConnBtn').disabled = false;
    $('#createConnBtn').textContent = 'Create connection';

    // Reset the receive screen.
    $('#recvStageOffer').hidden = false;
    $('#recvStageDone').hidden = true;
    $('#recvAnswerPanel').hidden = true;
    $('#recvTransferPanel').hidden = true;
    $('#recvTransfers').textContent = '';
    $('#recvIdleHint').hidden = false;
    $('#offerInput').value = '';
    $('#answerOut').value = '';
    $('#recvWaiting').hidden = false;
    $('#cancelRecvBtn').hidden = true;
    $('#joinBtn').disabled = false;
    $('#joinBtn').textContent = 'Join connection';
  }

  /* ---- QR helpers ---- */

  /**
   * Render `text` into a canvas, falling back to a message if it won't fit.
   * ECC level L maximises capacity; these codes are read from a bright screen
   * at close range, where the extra error correction buys us little.
   */
  function renderQr(canvasSel, fallbackSel, text) {
    const canvas = $(canvasSel);
    const fallback = $(fallbackSel);
    try {
      const matrix = QrEncoder.encode(text, { ecc: 0 });
      QrEncoder.render(canvas, matrix, { quiet: 4, target: 560 });
      canvas.hidden = false;
      fallback.hidden = true;
    } catch {
      canvas.hidden = true;
      fallback.hidden = false;
      fallback.textContent = 'This handshake is too long to fit in a QR code. Use the copy/paste option below instead.';
    }
  }

  /* ---- file list ---- */

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    let added = 0;
    for (const file of incoming) {
      // Directories dropped into the zone arrive as zero-byte, type-less entries.
      if (file.size === 0 && !file.type) {
        Util.toast(`"${file.name}" looks like a folder or an empty file — skipped.`, 'warn');
        continue;
      }
      const duplicate = state.files.some(
        (f) => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified,
      );
      if (duplicate) continue;
      state.files.push({ id: `f${fileSeq++}`, file });
      added++;
    }

    if (added) renderFileList();
  }

  function removeFile(id) {
    state.files = state.files.filter((f) => f.id !== id);
    renderFileList();
  }

  function renderFileList() {
    const list = $('#fileList');
    const summary = $('#fileSummary');
    if (!list) return;

    list.textContent = '';
    for (const { id, file } of state.files) {
      const row = el('li', 'file-row');

      row.appendChild(el('span', 'file-icon', Util.fileExt(file.name)));

      const meta = el('div', 'file-meta');
      const name = el('div', 'file-name', file.name);
      name.title = file.name;
      meta.appendChild(name);
      meta.appendChild(el('div', 'file-size', Util.formatBytes(file.size)));
      row.appendChild(meta);

      const remove = el('button', 'file-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      remove.addEventListener('click', () => removeFile(id));
      row.appendChild(remove);

      list.appendChild(row);
    }

    const total = state.files.reduce((sum, f) => sum + f.file.size, 0);
    summary.hidden = state.files.length === 0;
    $('#fileSummaryText').textContent =
      `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${Util.formatBytes(total)}`;

    updateSendReady();
  }

  function updateSendReady() {
    const btn = $('#startSendBtn');
    const hint = $('#sendReadyHint');
    if (!btn) return;
    const linked = !$('#sendStageLinked').hidden;
    const ready = linked && state.files.length > 0 && !state.sender?.active;
    btn.disabled = !ready;
    if (hint) {
      hint.hidden = state.files.length > 0;
    }
  }

  /* ---- transfer rows ---- */

  function transferRow(listSel, id, name, size) {
    const list = $(listSel);
    const root = el('li', 'transfer-row');
    root.dataset.state = 'active';

    const top = el('div', 'transfer-top');
    const nameEl = el('span', 'transfer-name', name);
    nameEl.title = name;
    top.appendChild(nameEl);
    const stateEl = el('span', 'transfer-state', 'Starting…');
    top.appendChild(stateEl);
    root.appendChild(top);

    const progress = el('div', 'progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', '0');
    progress.setAttribute('aria-label', `Transfer progress for ${name}`);
    const fill = el('div', 'progress-fill');
    progress.appendChild(fill);
    root.appendChild(progress);

    const stats = el('div', 'transfer-stats');
    root.appendChild(stats);

    const actions = el('div', 'transfer-actions');
    root.appendChild(actions);

    list.appendChild(root);
    const entry = { root, fill, stateEl, stats, actions, progress, size };
    state.rows.set(id, entry);
    return entry;
  }

  function updateRow(id, info) {
    const row = state.rows.get(id);
    if (!row) return;

    const done = info.sent ?? info.received ?? 0;
    const total = info.total || row.size || 0;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;

    row.fill.style.width = `${pct}%`;
    row.progress.setAttribute('aria-valuenow', String(Math.round(pct)));

    if (info.state) row.root.dataset.state = info.state;

    const labels = {
      active: `${Math.round(pct)}%`,
      done: 'Complete',
      cancelled: 'Cancelled',
      error: 'Failed',
    };
    row.stateEl.textContent = labels[info.state] || `${Math.round(pct)}%`;

    row.stats.textContent = '';
    const stat = (label, value) => {
      const span = el('span');
      span.appendChild(el('b', null, value));
      span.appendChild(document.createTextNode(` ${label}`));
      return span;
    };

    row.stats.appendChild(stat('transferred', `${Util.formatBytes(done)} / ${Util.formatBytes(total)}`));
    if (info.state === 'active') {
      row.stats.appendChild(stat('', Util.formatSpeed(info.speed)));
      if (Number.isFinite(info.eta) && info.eta > 0) {
        row.stats.appendChild(stat('remaining', Util.formatDuration(info.eta)));
      }
    }
  }

  function addDownload(id, blob, name) {
    const row = state.rows.get(id);
    if (!row) return;
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);

    const link = el('a', 'dl-link');
    link.href = url;
    link.download = name;
    link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
    link.appendChild(document.createTextNode(`Save ${name}`));
    row.actions.appendChild(link);
  }

  /* ---- shared connection handlers ---- */

  function connectionHandlers(extra = {}) {
    return {
      onStatus: (s) => setStatus(s),
      onError: (err) => {
        setStatus('error');
        Util.toast(err.message, 'error', 7000);
        extra.onError?.(err);
      },
      onClose: () => {
        // Only surprising if we weren't already finished.
        if (state.sender?.active || state.receiver?.current) {
          setStatus('error');
          Util.toast('The other device disconnected before the transfer finished.', 'error', 6000);
        }
        extra.onClose?.();
      },
      ...extra,
    };
  }

  /* ---- send flow ---- */

  async function createConnection() {
    const btn = $('#createConnBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    setStatus('connecting');

    try {
      state.connection = new Peer.Connection(connectionHandlers({
        onOpen: (channel) => onSenderChannelOpen(channel),
        onMessage: (data) => state.sender?.handleMessage(data),
      }));

      const token = await state.connection.createOffer();

      $('#offerText').value = token;
      renderQr('#offerQr', '#offerQrFallback', token);
      $('#sendStageStart').hidden = true;
      $('#sendStageOffer').hidden = false;
      setStatus('waiting');
    } catch (err) {
      setStatus('error');
      Util.toast(err.message || 'Could not create a connection.', 'error', 6000);
      btn.disabled = false;
      btn.textContent = 'Create connection';
      state.connection?.close();
      state.connection = null;
    }
  }

  async function acceptAnswer() {
    const token = $('#answerText').value.trim();
    if (!token) {
      Util.toast('Paste the reply code from the other device first.', 'warn');
      return;
    }
    if (!state.connection) {
      Util.toast('That connection expired. Create a new one.', 'warn');
      return;
    }

    const btn = $('#acceptAnswerBtn');
    btn.disabled = true;
    setStatus('connecting');

    try {
      await state.connection.acceptAnswer(token);
      Util.toast('Reply accepted — opening the channel…', 'info', 2500);
    } catch (err) {
      setStatus('waiting');
      Util.toast(err.message || 'That reply code could not be read.', 'error', 6000);
      btn.disabled = false;
    }
  }

  function onSenderChannelOpen(channel) {
    setStatus('connected');
    Util.vibrate(40);

    state.sender = new Transfer.Sender(channel, {
      onProgress: (id, info) => updateRow(id, info),
      onFileComplete: () => { /* per-file UI is handled by onProgress */ },
      onRemoteCancel: () => {
        Util.toast('The other device cancelled the transfer.', 'warn', 5000);
        setStatus('error');
      },
    });

    $('#sendStageOffer').hidden = true;
    $('#sendStageLinked').hidden = false;
    updateSendReady();
    Util.toast('Connected. You can send now.', 'ok');
  }

  async function startSending() {
    if (!state.sender || !state.files.length) return;

    $('#startSendBtn').disabled = true;
    $('#sendTransferPanel').hidden = false;
    $('#cancelSendBtn').hidden = false;
    $('#sendTransfers').textContent = '';
    state.rows.clear();
    setStatus('sending');

    for (const { id, file } of state.files) {
      transferRow('#sendTransfers', id, file.name, file.size);
    }

    const started = performance.now();
    const totalBytes = state.files.reduce((sum, f) => sum + f.file.size, 0);

    try {
      await state.sender.sendAll(state.files);

      if (state.sender.cancelled) {
        setStatus('error');
      } else {
        setStatus('complete');
        const seconds = (performance.now() - started) / 1000;
        Util.toast(
          `Sent ${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${Util.formatBytes(totalBytes)} in ${Util.formatDuration(seconds)}.`,
          'ok', 6000,
        );
        Util.vibrate([40, 60, 40]);
      }
    } catch (err) {
      setStatus('error');
      Util.toast(err.message || 'The transfer failed.', 'error', 7000);
      for (const { id } of state.files) {
        const row = state.rows.get(id);
        if (row && row.root.dataset.state === 'active') {
          updateRow(id, { state: 'error', total: row.size, sent: 0 });
        }
      }
    } finally {
      $('#cancelSendBtn').hidden = true;
      updateSendReady();
    }
  }

  /* ---- receive flow ---- */

  async function joinConnection() {
    const token = $('#offerInput').value.trim();
    if (!token) {
      Util.toast('Scan or paste the sender\'s invite code first.', 'warn');
      return;
    }

    const btn = $('#joinBtn');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    setStatus('connecting');

    try {
      state.connection = new Peer.Connection(connectionHandlers({
        onOpen: (channel) => onReceiverChannelOpen(channel),
        onMessage: (data) => state.receiver?.handleMessage(data),
      }));

      const answer = await state.connection.acceptOfferAndAnswer(token);

      $('#answerOut').value = answer;
      renderQr('#answerQr', '#answerQrFallback', answer);
      $('#recvStageOffer').hidden = true;
      $('#recvStageDone').hidden = false;
      $('#recvAnswerPanel').hidden = false;
      setStatus('waiting');
    } catch (err) {
      setStatus('error');
      Util.toast(err.message || 'That invite code could not be read.', 'error', 7000);
      btn.disabled = false;
      btn.textContent = 'Join connection';
      state.connection?.close();
      state.connection = null;
    }
  }

  function onReceiverChannelOpen(channel) {
    setStatus('connected');
    Util.vibrate(40);
    // The reply code has served its purpose; showing it now is just noise.
    $('#recvAnswerPanel').hidden = true;
    $('#recvStageDone').querySelector('.linked-title').textContent = 'Devices linked';
    $('#recvStageDone').querySelector('.linked-sub').textContent =
      'The channel is open and encrypted. Incoming files will appear below.';
    $('#recvWaiting').hidden = true;
    $('#recvTransferPanel').hidden = false;
    Util.toast('Connected. Waiting for files…', 'ok');

    state.receiver = new Transfer.Receiver(channel, {
      onFileStart: (id, info) => {
        $('#recvIdleHint').hidden = true;
        $('#cancelRecvBtn').hidden = false;
        setStatus('receiving');
        transferRow('#recvTransfers', id, info.name, info.size);
      },
      onProgress: (id, info) => updateRow(id, info),
      onFileComplete: (id, blob, name) => {
        addDownload(id, blob, name);
        Util.toast(`"${name}" received — ${Util.formatBytes(blob.size)}.`, 'ok', 5000);
        Util.vibrate([40, 60, 40]);
      },
      onAllDone: () => {
        setStatus('complete');
        $('#cancelRecvBtn').hidden = true;
        Util.toast('All files received. Use the Save buttons to keep them.', 'ok', 6000);
      },
      onRemoteCancel: () => {
        setStatus('error');
        $('#cancelRecvBtn').hidden = true;
        Util.toast('The sender cancelled the transfer.', 'warn', 5000);
      },
      onError: (err) => Util.toast(err.message, 'error', 6000),
    });
  }

  /* ---- scanner modal ---- */

  async function openScanner(targetSel) {
    state.scanTarget = targetSel;
    const modal = $('#scanModal');
    const hint = $('#scanHint');
    modal.hidden = false;
    hint.textContent = 'Starting the camera…';

    try {
      await Scanner.start({
        onStatus: (text) => { hint.textContent = text; },
        onResult: (text) => {
          Util.vibrate(60);
          const target = $(state.scanTarget);
          if (target) target.value = text.trim();
          closeScanner();
          Util.toast('Code scanned.', 'ok', 2500);
          // Move the flow along without another tap.
          if (state.scanTarget === '#offerInput') joinConnection();
          else if (state.scanTarget === '#answerText') acceptAnswer();
        },
      });
      await populateCameras();
    } catch (err) {
      hint.textContent = err.message;
      Util.toast(err.message, 'error', 6000);
    }
  }

  async function populateCameras() {
    const select = $('#cameraSelect');
    const cameras = await Scanner.listCameras();
    if (cameras.length < 2) {
      select.hidden = true;
      return;
    }
    select.textContent = '';
    cameras.forEach((cam, i) => {
      const option = el('option', null, cam.label || `Camera ${i + 1}`);
      option.value = cam.deviceId;
      select.appendChild(option);
    });
    select.hidden = false;
  }

  function closeScanner() {
    Scanner.stop();
    $('#scanModal').hidden = true;
  }

  /* ---- event wiring ---- */

  function wireNav() {
    document.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const target = btn.dataset.nav;
        if (target === 'home') goHome();
        else if (target === 'send') { teardown(); show('#screen-send'); setStatus('idle'); }
        else if (target === 'receive') { teardown(); show('#screen-receive'); setStatus('idle'); }
      });
    });
  }

  function wireDropzone() {
    const zone = $('#dropzone');
    const input = $('#fileInput');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';                                      // allow re-picking the same file
    });

    // dragenter/dragleave fire for child elements too, so count the depth.
    let depth = 0;
    zone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth++;
      zone.classList.add('is-dragging');
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('is-dragging');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragging');
      addFiles(event.dataTransfer?.files);
    });

    // Dropping anywhere else shouldn't make the browser navigate to the file.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    $('#clearFilesBtn').addEventListener('click', () => {
      state.files = [];
      renderFileList();
    });
  }

  function wireCopyPaste() {
    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = $(btn.dataset.copy);
        const ok = await Util.copyText(target.value);
        Util.toast(
          ok ? 'Copied to the clipboard.' : 'Could not copy automatically — select the text and copy it manually.',
          ok ? 'ok' : 'warn',
          3000,
        );
      });
    });

    document.querySelectorAll('[data-paste]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = await Util.readClipboard();
        if (text == null) {
          Util.toast('This browser will not let a page read the clipboard. Paste into the box with Ctrl/Cmd+V.', 'warn', 5000);
          $(btn.dataset.paste).focus();
          return;
        }
        $(btn.dataset.paste).value = text.trim();
        Util.toast('Pasted.', 'ok', 2000);
      });
    });

    document.querySelectorAll('[data-scan]').forEach((btn) => {
      btn.addEventListener('click', () => openScanner(btn.dataset.scan));
    });
  }

  function wireModal() {
    $('#scanCloseBtn').addEventListener('click', closeScanner);
    document.querySelectorAll('[data-close-modal]').forEach((node) => {
      node.addEventListener('click', closeScanner);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#scanModal').hidden) closeScanner();
    });
    $('#cameraSelect').addEventListener('change', (event) => {
      openScannerWithDevice(event.target.value);
    });
  }

  async function openScannerWithDevice(deviceId) {
    const hint = $('#scanHint');
    try {
      await Scanner.start({
        deviceId,
        onStatus: (text) => { hint.textContent = text; },
        onResult: (text) => {
          const target = $(state.scanTarget);
          if (target) target.value = text.trim();
          closeScanner();
          if (state.scanTarget === '#offerInput') joinConnection();
          else if (state.scanTarget === '#answerText') acceptAnswer();
        },
      });
    } catch (err) {
      hint.textContent = err.message;
    }
  }

  function wireActions() {
    $('#createConnBtn').addEventListener('click', createConnection);
    $('#acceptAnswerBtn').addEventListener('click', acceptAnswer);
    $('#startSendBtn').addEventListener('click', startSending);
    $('#joinBtn').addEventListener('click', joinConnection);

    $('#cancelSendBtn').addEventListener('click', () => {
      state.sender?.cancel();
      setStatus('error');
      Util.toast('Transfer cancelled.', 'warn', 3000);
      $('#cancelSendBtn').hidden = true;
    });

    $('#cancelRecvBtn').addEventListener('click', () => {
      state.receiver?.cancel();
      setStatus('error');
      Util.toast('Transfer cancelled.', 'warn', 3000);
      $('#cancelRecvBtn').hidden = true;
    });

    // Warn before navigating away mid-transfer.
    window.addEventListener('beforeunload', (event) => {
      if (state.sender?.active || state.receiver?.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    window.addEventListener('pagehide', () => {
      Scanner.stop();
      state.connection?.close();
    });
  }

  /* ---- boot ---- */

  function init() {
    const problem = Peer.checkSupport();
    if (problem) {
      const note = $('#compatNote');
      note.textContent = problem;
      note.hidden = false;
      document.querySelectorAll('.choice-card').forEach((card) => { card.disabled = true; });
      return;
    }

    if (!Scanner.isSupported()) {
      // Camera scanning is a convenience; copy/paste always works.
      document.querySelectorAll('[data-scan]').forEach((btn) => { btn.hidden = true; });
    }

    wireNav();
    wireDropzone();
    wireCopyPaste();
    wireModal();
    wireActions();
    setStatus('idle');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
