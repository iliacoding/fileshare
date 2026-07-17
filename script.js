/* ==========================================================================
   Beam — peer-to-peer file transfer
   --------------------------------------------------------------------------
   A single-page, dependency-free WebRTC file transfer app.

   There is no backend. Two peers meet using a short code: both sides derive a
   secret topic and an encryption key from it, swap an encrypted WebRTC
   handshake through a public broker, and then talk directly. The broker only
   ever relays two short ciphertexts — files always move peer to peer.

   Module map:
     Util        — DOM helpers, formatting, toasts
     Rendezvous  — short codes, key derivation, encrypted broker transport
     Signal      — SDP <-> compact handshake token
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

  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
    pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
  };

  /**
   * Best-effort media type for a received file.
   *
   * This matters more than it looks: iOS only offers "Save Image"/"Save Video"
   * in the share sheet when the file carries a real media type, and some file
   * pickers hand us an empty or generic type.
   */
  const guessMime = (name, given) => {
    if (given && given !== 'application/octet-stream') return given;
    const ext = String(name).split('.').pop()?.toLowerCase();
    return MIME_BY_EXT[ext] || given || 'application/octet-stream';
  };

  const isSaveableMedia = (mime) => /^(image|video)\//.test(mime || '');

  /** A message that is exactly one http(s) link, or null. */
  const asSingleUrl = (text) => {
    const trimmed = String(text).trim();
    if (!trimmed || /\s/.test(trimmed)) return null;
    try {
      const url = new URL(trimmed);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  /** Strip path separators and control characters from a peer-supplied name. */
  const sanitizeFilename = (name) => {
    const cleaned = String(name || 'file')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/]/g, '_')
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
    guessMime, isSaveableMedia, asSingleUrl,
    bytesToBase64Url, base64UrlToBytes, bytesToBase64, base64ToBytes,
    toast, copyText, readClipboard, vibrate,
  };
})();

/* ==========================================================================
   Rendezvous — short-code introductions over a public broker

   WebRTC needs both peers to swap an SDP before they can talk, and that swap
   has to happen somewhere. Typing ~120 characters by hand is miserable, so the
   two sides instead meet on a public ntfy.sh topic derived from a short code.

   The code is the only secret. From it we derive, via PBKDF2:
     - the topic name, which is what makes the meeting point unguessable
     - an AES-GCM key, so the broker only ever relays ciphertext

   The broker never sees a filename or a byte of file data; it carries exactly
   two encrypted handshake messages and is out of the picture once the peers
   connect directly.

   Security note: a 6-character code is ~30 bits. That is deliberately not
   strong enough to protect a long-lived secret, and it doesn't have to be —
   an attacker must first find the topic, which means guessing online against
   a rate-limited broker during the few seconds a session is live. PBKDF2 with
   a high iteration count makes each guess expensive. If you want more margin,
   raise CODE_LENGTH.
   ========================================================================== */
const Rendezvous = (() => {
  const BROKER = 'https://ntfy.sh';

  // Crockford-style alphabet: no I, L, O or U, so codes can't be misread or
  // accidentally spell anything. 32 chars divides 256 evenly — no modulo bias.
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_LENGTH = 6;

  const PBKDF2_ITERATIONS = 250000;
  const REPLAY_WINDOW = '10m';        // let a peer pick up a handshake sent before it subscribed

  // Offsets (ms) for the catch-up polls. The broker's cache takes a moment to
  // become readable after a publish, so one immediate poll is not enough.
  const HISTORY_POLL_DELAYS = [0, 800, 2000, 4000, 8000];

  const ROLE_OFFER = 'o';
  const ROLE_ANSWER = 'a';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  /* ---- codes ---- */

  function generateCode() {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  /** Accept sloppy input: lowercase, dashes, and the classic O/0 I/1 mixups. */
  function normalizeCode(input) {
    return String(input || '')
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0')
      .replace(/U/g, 'V');
  }

  const formatCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

  const isValidCode = (code) =>
    code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));

  /* ---- key derivation ---- */

  /**
   * Stretch the short code into a topic name and an encryption key.
   * Deliberately slow: this is the only thing standing between a guessed code
   * and the handshake.
   */
  async function deriveSession(code) {
    const material = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
    const master = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: enc.encode('beam-rendezvous-v1'),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    }, material, 256));

    const topicBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(master, enc.encode('topic'))));
    const keyBytes = await crypto.subtle.digest('SHA-256', concat(master, enc.encode('key')));

    const topic = 'beam1' + Array.from(topicBytes.slice(0, 12))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

    return { topic, key };
  }

  /* ---- sealed messages ---- */

  /** role || base64url(iv || ciphertext); the role is authenticated as AAD. */
  async function seal(session, role, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(role) },
      session.key,
      enc.encode(text),
    ));
    return role + Util.bytesToBase64Url(concat(iv, ct));
  }

  /** Returns null when the payload isn't ours to read (wrong role or key). */
  async function unseal(session, role, payload) {
    if (typeof payload !== 'string' || payload[0] !== role) return null;
    try {
      const bytes = Util.base64UrlToBytes(payload.slice(1));
      if (bytes.length <= 12) return null;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(role) },
        session.key,
        bytes.subarray(12),
      );
      return dec.decode(plain);
    } catch {
      // Wrong key, or a stray message on a colliding topic.
      return null;
    }
  }

  /* ---- transport ---- */

  async function publish(session, payload) {
    let res;
    try {
      res = await fetch(`${BROKER}/${session.topic}`, { method: 'POST', body: payload });
    } catch {
      throw new Error('Could not reach the connection service. Check your internet and try again.');
    }
    if (!res.ok) {
      throw new Error(res.status === 429
        ? 'The connection service is rate-limiting us. Wait a moment and try again.'
        : 'The connection service rejected the request. Try again.');
    }
  }

  /**
   * Listen for messages on the topic. Returns a stop() function.
   *
   * Two sources, because neither alone is enough:
   *
   *  - The SSE stream ignores `since`, so it only carries messages sent after
   *    it opens. But the sender normally publishes its offer long before the
   *    receiver has finished typing the code.
   *  - The history poll covers that, except ntfy's cache is eventually
   *    consistent: a poll issued immediately after a successful publish comes
   *    back empty, and the message shows up a second or so later. So we retry
   *    the poll on a short backoff instead of trusting one shot.
   *
   * Both feed the same handler, de-duplicated by message id.
   */
  function subscribe(session, onPayload, onError) {
    let stopped = false;
    const seen = new Set();

    const deliver = (msg) => {
      if (stopped || !msg || msg.event !== 'message' || typeof msg.message !== 'string') return;
      if (msg.id) {
        if (seen.has(msg.id)) return;      // already delivered by the other source
        seen.add(msg.id);
      }
      onPayload(msg.message);
    };

    const pollHistory = async () => {
      try {
        const res = await fetch(`${BROKER}/${session.topic}/json?poll=1&since=${REPLAY_WINDOW}`);
        if (!res.ok) return;
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { deliver(JSON.parse(line)); } catch { /* skip malformed line */ }
        }
      } catch {
        // Offline or blocked; the live stream may still succeed.
      }
    };

    // Catch up on anything already waiting, allowing for cache lag.
    (async () => {
      for (const delay of HISTORY_POLL_DELAYS) {
        if (stopped) return;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (stopped) return;
        await pollHistory();
      }
    })();

    // Anything that arrives from now on.
    const source = new EventSource(`${BROKER}/${session.topic}/sse`);
    source.onmessage = (event) => {
      try { deliver(JSON.parse(event.data)); } catch { /* not a message frame */ }
    };
    source.onerror = () => {
      // EventSource retries on its own; only a hard close is worth reporting.
      if (!stopped && source.readyState === EventSource.CLOSED) {
        onError?.(new Error('Lost contact with the connection service.'));
      }
    };

    return () => { stopped = true; source.close(); };
  }

  const isSupported = () =>
    typeof EventSource !== 'undefined' && !!(crypto && crypto.subtle);

  return {
    generateCode, normalizeCode, formatCode, isValidCode,
    deriveSession, seal, unseal, publish, subscribe, isSupported,
    ROLE_OFFER, ROLE_ANSWER, CODE_LENGTH,
  };
})();

/* ==========================================================================
   Signal — SDP <-> compact handshake token

   A browser's SDP offer is ~3 KB, almost all of it boilerplate both peers
   already agree on. Only a few fields actually vary, and most of those are
   incompressible random bytes (the DTLS fingerprint, the ICE password), so
   generic compression buys nothing. Instead we pack the fields into a binary
   record and base64url it — that gets a typical offer to ~120 characters,
   which keeps the QR sparse enough to scan comfortably.

   Wire format (after the "B" prefix, base64url-encoded):

     byte 0   : version (high nibble) | isAnswer << 3 | setup role (low 3 bits)
     byte 1   : ICE ufrag length, followed by that many ASCII bytes
     byte n   : ICE pwd length, followed by that many ASCII bytes
     32 bytes : SHA-256 DTLS fingerprint
     byte     : candidate count, then one record each:
                  byte kind, address bytes (per kind), 2-byte big-endian port

   sctp-port and max-message-size are omitted: every browser uses port 5000,
   and we only ever send 16 KB chunks, far below any peer's message limit.
   ========================================================================== */
const Signal = (() => {
  const PREFIX = 'B';
  const FORMAT_VERSION = 1;

  const SETUP_CODES = ['actpass', 'active', 'passive'];

  // Candidate record kinds. Fixed-width address forms keep the common cases
  // tiny; kind 7 is an escape hatch for anything unexpected.
  const KIND = {
    HOST_MDNS: 0,   // 16-byte UUID, rebuilt as "<uuid>.local"
    HOST_IP4: 1,
    HOST_IP6: 2,
    SRFLX_IP4: 3,
    SRFLX_IP6: 4,
    RELAY_IP4: 5,
    RELAY_IP6: 6,
    GENERIC: 7,     // [type code][length][ASCII address]
  };

  const TYPE_CODES = ['host', 'srflx', 'relay'];

  // Only affects candidate ordering; exact values are not meaningful to us.
  const PRIORITIES = { host: 2130706431, srflx: 1694498815, relay: 16777215 };

  // Every extra candidate makes the QR denser. Machines with VPN or virtual
  // adapters can gather a dozen; a few of the best ones is plenty to connect.
  const MAX_CANDIDATES = 4;

  const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

  const match = (sdp, re) => {
    const m = sdp.match(re);
    return m ? m[1].trim() : null;
  };

  /* ---- address helpers ---- */

  const parseIp4 = (ip) => {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const n = Number(parts[i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out[i] = n;
    }
    return out;
  };

  const formatIp4 = (bytes) => Array.from(bytes).join('.');

  /** Expand an IPv6 literal (including a "::" run) to 16 bytes. */
  const parseIp6 = (ip) => {
    if (!ip.includes(':')) return null;
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    const groups = tail === null
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    if (groups.length !== 8) return null;

    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const n = parseInt(groups[i] || '0', 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      out[i * 2] = n >> 8;
      out[i * 2 + 1] = n & 0xff;
    }
    return out;
  };

  const formatIp6 = (bytes) => {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return groups.join(':');
  };

  const parseUuid = (addr) => {
    const m = addr.match(UUID_RE);
    if (!m) return null;
    const hex = m.slice(1).join('');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  };

  const formatUuid = (bytes) => {
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
  };

  /* ---- byte writer / reader ---- */

  class Writer {
    constructor() { this.bytes = []; }
    u8(v) { this.bytes.push(v & 0xff); }
    u16(v) { this.bytes.push((v >> 8) & 0xff, v & 0xff); }
    raw(arr) { for (const b of arr) this.bytes.push(b & 0xff); }
    ascii(str) {
      const bytes = new TextEncoder().encode(str);
      if (bytes.length > 255) throw new Error('Handshake field is unexpectedly long.');
      this.u8(bytes.length);
      this.raw(bytes);
    }
    toBytes() { return Uint8Array.from(this.bytes); }
  }

  class Reader {
    constructor(bytes) { this.bytes = bytes; this.pos = 0; }
    need(n) {
      if (this.pos + n > this.bytes.length) throw new Error('truncated');
    }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    u16() { this.need(2); const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1]; this.pos += 2; return v; }
    raw(n) { this.need(n); const v = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    ascii() { const n = this.u8(); return new TextDecoder().decode(this.raw(n)); }
  }

  /* ---- SDP -> bytes ---- */

  /** Pull out the candidates worth sending, best first, capped. */
  function collectCandidates(sdp) {
    const found = [];
    const seen = new Set();
    const re = /^a=candidate:(.+)$/gm;
    let m;
    while ((m = re.exec(sdp)) !== null) {
      const parts = m[1].split(' ');
      const [, component, transport, , addr, port] = parts;
      const typIndex = parts.indexOf('typ');
      const type = typIndex >= 0 ? parts[typIndex + 1] : null;

      // Component 1 UDP only: TCP candidates rarely win the pair and would
      // cost QR space we would rather not spend.
      if (component !== '1') continue;
      if (!transport || transport.toLowerCase() !== 'udp') continue;
      if (!TYPE_CODES.includes(type)) continue;

      const key = `${type}|${addr}|${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ type, addr, port: Number(port) });
    }

    // One srflx covers the internet path; spend the rest of the budget on host
    // candidates, which are what make same-network transfers work.
    const host = found.filter((c) => c.type === 'host');
    const srflx = found.filter((c) => c.type === 'srflx').slice(0, 1);
    const relay = found.filter((c) => c.type === 'relay').slice(0, 1);
    return [...host, ...srflx, ...relay].slice(0, MAX_CANDIDATES);
  }

  function writeCandidate(w, cand) {
    const { type, addr, port } = cand;

    if (type === 'host') {
      const uuid = parseUuid(addr);
      if (uuid) { w.u8(KIND.HOST_MDNS); w.raw(uuid); w.u16(port); return; }
    }

    const ip4 = parseIp4(addr);
    if (ip4) {
      w.u8({ host: KIND.HOST_IP4, srflx: KIND.SRFLX_IP4, relay: KIND.RELAY_IP4 }[type]);
      w.raw(ip4); w.u16(port); return;
    }

    const ip6 = parseIp6(addr);
    if (ip6) {
      w.u8({ host: KIND.HOST_IP6, srflx: KIND.SRFLX_IP6, relay: KIND.RELAY_IP6 }[type]);
      w.raw(ip6); w.u16(port); return;
    }

    // Unknown address shape (e.g. a non-UUID .local name) — store it verbatim.
    w.u8(KIND.GENERIC);
    w.u8(TYPE_CODES.indexOf(type));
    w.ascii(addr);
    w.u16(port);
  }

  function readCandidate(r) {
    const kind = r.u8();
    let type, addr;
    switch (kind) {
      case KIND.HOST_MDNS: type = 'host'; addr = formatUuid(r.raw(16)); break;
      case KIND.HOST_IP4:  type = 'host'; addr = formatIp4(r.raw(4)); break;
      case KIND.HOST_IP6:  type = 'host'; addr = formatIp6(r.raw(16)); break;
      case KIND.SRFLX_IP4: type = 'srflx'; addr = formatIp4(r.raw(4)); break;
      case KIND.SRFLX_IP6: type = 'srflx'; addr = formatIp6(r.raw(16)); break;
      case KIND.RELAY_IP4: type = 'relay'; addr = formatIp4(r.raw(4)); break;
      case KIND.RELAY_IP6: type = 'relay'; addr = formatIp6(r.raw(16)); break;
      case KIND.GENERIC: {
        type = TYPE_CODES[r.u8()];
        addr = r.ascii();
        if (!type) throw new Error('bad candidate type');
        break;
      }
      default: throw new Error('bad candidate kind');
    }
    return { type, addr, port: r.u16() };
  }

  /** Pull the fields we care about out of a real SDP and pack them. */
  function packSdp(sdp, sdpType) {
    const ufrag = match(sdp, /^a=ice-ufrag:(.+)$/m);
    const pwd = match(sdp, /^a=ice-pwd:(.+)$/m);
    const fingerprintHex = match(sdp, /^a=fingerprint:sha-256 (.+)$/mi);
    const setup = match(sdp, /^a=setup:(\w+)$/m) || 'actpass';

    if (!ufrag || !pwd || !fingerprintHex) {
      throw new Error('This browser produced a handshake we cannot read.');
    }

    const fp = Uint8Array.from(fingerprintHex.split(':').map((h) => parseInt(h, 16)));
    if (fp.length !== 32 || fp.some(Number.isNaN)) {
      throw new Error('Unexpected DTLS fingerprint format.');
    }

    const candidates = collectCandidates(sdp);
    if (!candidates.length) {
      throw new Error('No usable network candidates were found. Check your connection and try again.');
    }

    const w = new Writer();
    const setupCode = Math.max(0, SETUP_CODES.indexOf(setup));
    w.u8((FORMAT_VERSION << 4) | ((sdpType === 'answer' ? 1 : 0) << 3) | setupCode);
    w.ascii(ufrag);
    w.ascii(pwd);
    w.raw(fp);
    w.u8(candidates.length);
    for (const c of candidates) writeCandidate(w, c);
    return w.toBytes();
  }

  /** Rebuild a canonical, browser-acceptable SDP from the packed bytes. */
  function unpackSdp(bytes) {
    const r = new Reader(bytes);
    const head = r.u8();
    if ((head >> 4) !== FORMAT_VERSION) {
      throw new Error('That code was made by a different version of this app.');
    }
    const isAnswer = ((head >> 3) & 1) === 1;
    const setup = SETUP_CODES[head & 0x07] || 'actpass';

    const ufrag = r.ascii();
    const pwd = r.ascii();
    const fp = r.raw(32);
    const count = r.u8();
    if (count < 1) throw new Error('no candidates');

    const candidates = [];
    for (let i = 0; i < count; i++) candidates.push(readCandidate(r));

    const fpHex = Array.from(fp)
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
      const isIp6 = c.addr.includes(':');
      let line = `a=candidate:${i + 1} 1 udp ${PRIORITIES[c.type]} ${c.addr} ${c.port} typ ${c.type}`;
      if (c.type !== 'host') {
        // raddr/rport are informational to the far side; zeros are accepted.
        line += isIp6 ? ' raddr :: rport 0' : ' raddr 0.0.0.0 rport 0';
      }
      lines.push(line + ' generation 0');
    });

    lines.push(
      'a=end-of-candidates',
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${fpHex}`,
      `a=setup:${setup}`,
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
    );

    return { type: isAnswer ? 'answer' : 'offer', sdp: lines.join('\r\n') + '\r\n' };
  }

  /* ---- public API ---- */

  /** RTCSessionDescription -> short shareable token. */
  function encode(description) {
    return PREFIX + Util.bytesToBase64Url(packSdp(description.sdp, description.type));
  }

  /**
   * Token -> {type, sdp}. Accepts a bare token or a full URL carrying one in
   * its fragment, so a scanned link and a pasted code take the same path.
   * Throws a user-facing Error on malformed input.
   */
  function decode(token) {
    let text = String(token || '').trim();

    // A scanned invite is a URL like https://host/path#c=<token>.
    const hash = text.indexOf('#');
    if (hash >= 0 && /^https?:/i.test(text)) text = text.slice(hash + 1);
    text = text.replace(/^[?#]?(?:c=)?/, '').replace(/\s+/g, '');

    if (!text) throw new Error('Nothing to read — the code is empty.');
    if (text[0] !== PREFIX) {
      throw new Error('That does not look like a Beam code. Make sure you copied the whole thing.');
    }

    let bytes;
    try {
      bytes = Util.base64UrlToBytes(text.slice(1));
    } catch {
      throw new Error('That code looks damaged or incomplete. Try again.');
    }

    try {
      return unpackSdp(bytes);
    } catch (err) {
      // Surface our own explanatory errors; collapse structural ones.
      if (/different version/.test(err.message)) throw err;
      throw new Error('That code looks damaged or incomplete. Try again.');
    }
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
      const description = Signal.decode(token);
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
      const description = Signal.decode(token);
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
    TEXT: 'text',
    CANCEL: 'cancel',
    DONE: 'all-done',
  };

  // A pasted message should never be big enough to matter; anything larger is
  // either a mistake or someone poking at us.
  const MAX_TEXT_LENGTH = 100000;

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

    /** Send a text message. Small enough to go in one control frame. */
    sendText(body) {
      const text = String(body).slice(0, MAX_TEXT_LENGTH);
      this._send({ type: MSG.TEXT, id: `t${Date.now()}`, body: text });
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
        case MSG.TEXT: {
          const body = typeof msg.body === 'string' ? msg.body.slice(0, MAX_TEXT_LENGTH) : '';
          if (!body) return;
          this.handlers.onText?.(String(msg.id), body);
          break;
        }

        case MSG.START: {
          // Validate before trusting anything the peer told us.
          const size = Number(msg.size);
          if (!Number.isFinite(size) || size < 0) return;
          const name = Util.sanitizeFilename(msg.name);
          this.current = {
            id: String(msg.id),
            name,
            size,
            mime: Util.guessMime(name, typeof msg.mime === 'string' ? msg.mime : ''),
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
          this.handlers.onFileComplete?.(file.id, blob, file.name, file.mime);
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

  // How long a receiver waits for a sender to show up on the topic before
  // concluding the code is wrong or the sender has gone away.
  const OFFER_WAIT_MS = 30000;

  const state = {
    connection: null,
    sender: null,
    receiver: null,
    files: [],           // {id, file}
    rows: new Map(),     // id -> row parts
    objectUrls: [],
    unsubscribe: null,   // stops the broker subscription
    waitTimer: 0,
    recvFileCount: 0,
    recvTextCount: 0,
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
    window.scrollTo(0, 0);
  }

  function goHome() {
    teardown();
    show('#screen-home');
    setStatus('idle');
  }

  /** Drop the connection, stop listening, and reset all per-session UI. */
  function teardown() {
    state.unsubscribe?.();
    state.unsubscribe = null;
    clearTimeout(state.waitTimer);

    state.connection?.close();
    state.connection = null;
    state.sender = null;
    state.receiver = null;

    state.objectUrls.forEach(URL.revokeObjectURL);
    state.objectUrls = [];
    state.rows.clear();
    state.recvFileCount = 0;
    state.recvTextCount = 0;

    state.files = [];
    $('#messageInput').value = '';
    renderFileList();

    // Send screen.
    $('#sendStageStart').hidden = false;
    $('#sendStageCode').hidden = true;
    $('#sendStageLinked').hidden = true;
    $('#sendTransferPanel').hidden = true;
    $('#sendTransfers').textContent = '';
    $('#cancelSendBtn').hidden = true;
    $('#createCodeBtn').disabled = false;
    $('#createCodeBtn').textContent = 'Get a code';
    $('#codeValue').textContent = '···-···';
    $('#sendWaiting').hidden = false;

    // Receive screen.
    $('#recvStageCode').hidden = false;
    $('#recvStageLinked').hidden = true;
    $('#recvTransferPanel').hidden = true;
    $('#recvTransfers').textContent = '';
    $('#recvIdleHint').hidden = false;
    $('#codeInput').value = '';
    $('#recvError').hidden = true;
    $('#cancelRecvBtn').hidden = true;
    setJoinBusy(false);
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

  const messageText = () => $('#messageInput').value.trim();

  function updateSendReady() {
    const btn = $('#startSendBtn');
    const hint = $('#sendReadyHint');
    if (!btn) return;
    const linked = !$('#sendStageLinked').hidden;
    const hasSomething = state.files.length > 0 || messageText().length > 0;
    btn.disabled = !(linked && hasSomething && !state.sender?.active);
    if (hint) hint.hidden = hasSomething;
  }

  /* ---- transfer rows ---- */

  function transferRow(listSel, id, name, size) {
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

    $(listSel).appendChild(root);
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

    const labels = { active: `${Math.round(pct)}%`, done: 'Complete', cancelled: 'Cancelled', error: 'Failed' };
    row.stateEl.textContent = labels[info.state] || `${Math.round(pct)}%`;

    row.stats.textContent = '';
    const stat = (label, value) => {
      const span = el('span');
      span.appendChild(el('b', null, value));
      if (label) span.appendChild(document.createTextNode(` ${label}`));
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

  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
  const ICON_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3"/><path d="m8 7 4-4 4 4"/><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/></svg>';

  /**
   * Offer the ways this platform can actually keep a received file.
   *
   * A download link can't reach the iOS photo library — Safari files downloads
   * away in the Files app. The native share sheet is the only route to "Save
   * Image"/"Save Video", so when the platform can share the file we lead with
   * that, and keep the plain download as a fallback everywhere.
   */
  function addSaveActions(id, blob, name, mime) {
    const row = state.rows.get(id);
    if (!row) return;

    const file = new File([blob], name, { type: mime });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));

    if (canShare) {
      const media = Util.isSaveableMedia(mime);
      const btn = el('button', 'dl-link');
      btn.type = 'button';
      btn.innerHTML = ICON_SHARE;
      btn.appendChild(document.createTextNode(media ? 'Save to Photos' : 'Share'));
      btn.addEventListener('click', async () => {
        try {
          // Must stay inside the user gesture, so no awaits before this.
          await navigator.share({ files: [file] });
        } catch (err) {
          // Dismissing the sheet is normal, not a failure worth reporting.
          if (err && err.name !== 'AbortError') {
            Util.toast('This device would not open the share sheet. Use Save instead.', 'warn', 5000);
          }
        }
      });
      row.actions.appendChild(btn);
    }

    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    const link = el('a', canShare ? 'dl-link dl-quiet' : 'dl-link');
    link.href = url;
    link.download = name;
    link.innerHTML = ICON_DOWNLOAD;
    link.appendChild(document.createTextNode('Save'));
    row.actions.appendChild(link);
  }

  /** A received or sent text message, rendered as a card in the transfer list. */
  function textRow(listSel, body, stateLabel) {
    const root = el('li', 'transfer-row text-row');
    root.dataset.state = 'done';

    const top = el('div', 'transfer-top');
    top.appendChild(el('span', 'transfer-name', 'Message'));
    top.appendChild(el('span', 'transfer-state', stateLabel));
    root.appendChild(top);

    // textContent, never innerHTML: this string came from the other device.
    root.appendChild(el('pre', 'text-body', body));

    const actions = el('div', 'transfer-actions');
    const copy = el('button', 'dl-link');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const ok = await Util.copyText(body);
      Util.toast(ok ? 'Copied.' : 'Could not copy — select the text instead.', ok ? 'ok' : 'warn', 2500);
    });
    actions.appendChild(copy);

    // Sending yourself a link is the main reason to use this at all.
    const url = Util.asSingleUrl(body);
    if (url) {
      const open = el('a', 'dl-link dl-quiet');
      open.href = url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Open link';
      actions.appendChild(open);
    }

    root.appendChild(actions);
    $(listSel).appendChild(root);
  }

  /* ---- shared connection handlers ---- */

  function connectionHandlers(extra = {}) {
    return {
      onStatus: (s) => setStatus(s),
      onError: (err) => {
        setStatus('error');
        Util.toast(err.message, 'error', 7000);
      },
      onClose: () => {
        if (state.sender?.active || state.receiver?.current) {
          setStatus('error');
          Util.toast('The other device disconnected before the transfer finished.', 'error', 6000);
        }
      },
      ...extra,
    };
  }

  /* ---- send flow ---- */

  async function createCode() {
    const btn = $('#createCodeBtn');
    btn.disabled = true;
    btn.textContent = 'Getting a code…';
    setStatus('connecting');

    try {
      const code = Rendezvous.generateCode();
      const session = await Rendezvous.deriveSession(code);

      state.connection = new Peer.Connection(connectionHandlers({
        onOpen: (channel) => onSenderChannelOpen(channel),
        onMessage: (data) => state.sender?.handleMessage(data),
      }));

      const offer = await state.connection.createOffer();
      await Rendezvous.publish(session, await Rendezvous.seal(session, Rendezvous.ROLE_OFFER, offer));

      $('#codeValue').textContent = Rendezvous.formatCode(code);
      $('#sendStageStart').hidden = true;
      $('#sendStageCode').hidden = false;
      setStatus('waiting');

      // Listen for the receiver's answer. Our own offer comes back on this
      // stream too; the role prefix makes it a no-op.
      let accepted = false;
      state.unsubscribe = Rendezvous.subscribe(session, async (payload) => {
        if (accepted) return;
        const answer = await Rendezvous.unseal(session, Rendezvous.ROLE_ANSWER, payload);
        if (!answer) return;
        accepted = true;
        state.unsubscribe?.();
        state.unsubscribe = null;
        try {
          setStatus('connecting');
          $('#sendWaitingText').textContent = 'Someone answered — connecting…';
          await state.connection.acceptAnswer(answer);
        } catch (err) {
          setStatus('error');
          Util.toast(err.message || 'That reply could not be used.', 'error', 6000);
        }
      }, (err) => Util.toast(err.message, 'warn', 5000));
    } catch (err) {
      setStatus('error');
      Util.toast(err.message || 'Could not create a code.', 'error', 6000);
      btn.disabled = false;
      btn.textContent = 'Get a code';
      state.connection?.close();
      state.connection = null;
    }
  }

  function onSenderChannelOpen(channel) {
    setStatus('connected');
    Util.vibrate(40);

    state.sender = new Transfer.Sender(channel, {
      onProgress: (id, info) => updateRow(id, info),
      onRemoteCancel: () => {
        Util.toast('The other device cancelled the transfer.', 'warn', 5000);
        setStatus('error');
      },
    });

    $('#sendStageCode').hidden = true;
    $('#sendStageLinked').hidden = false;
    updateSendReady();
    Util.toast('Connected. You can send now.', 'ok');
  }

  async function startSending() {
    const message = messageText();
    if (!state.sender || (!state.files.length && !message)) return;

    $('#startSendBtn').disabled = true;
    $('#sendTransferPanel').hidden = false;
    $('#sendTransfers').textContent = '';
    state.rows.clear();
    setStatus('sending');

    // The message rides in a single control frame, so it lands immediately.
    if (message) {
      try {
        state.sender.sendText(message);
        textRow('#sendTransfers', message, 'Sent');
        $('#messageInput').value = '';
      } catch (err) {
        setStatus('error');
        Util.toast(err.message || 'The message could not be sent.', 'error', 6000);
        updateSendReady();
        return;
      }
    }

    const fileCount = state.files.length;
    if (fileCount) {
      $('#cancelSendBtn').hidden = false;
      for (const { id, file } of state.files) transferRow('#sendTransfers', id, file.name, file.size);
    }

    const started = performance.now();
    const totalBytes = state.files.reduce((sum, f) => sum + f.file.size, 0);

    try {
      // Always goes through sendAll, even with no files: it emits the
      // end-of-transfer marker that moves the receiver off "Connected".
      await state.sender.sendAll(state.files);
      if (state.sender.cancelled) {
        setStatus('error');
      } else {
        setStatus('complete');
        if (fileCount) {
          const seconds = (performance.now() - started) / 1000;
          Util.toast(
            `Sent ${fileCount} file${fileCount === 1 ? '' : 's'} · ${Util.formatBytes(totalBytes)} in ${Util.formatDuration(seconds)}.`,
            'ok', 6000,
          );
          Util.vibrate([40, 60, 40]);
        } else {
          Util.toast('Message sent.', 'ok', 3500);
          Util.vibrate(40);
        }
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

  function setJoinBusy(busy) {
    const btn = $('#joinBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Connecting…' : 'Connect';
    $('#codeInput').disabled = busy;
  }

  function showRecvError(message) {
    const node = $('#recvError');
    node.textContent = message;
    node.hidden = !message;
  }

  async function joinWithCode() {
    const code = Rendezvous.normalizeCode($('#codeInput').value);
    showRecvError('');

    if (!Rendezvous.isValidCode(code)) {
      showRecvError(`Enter the ${Rendezvous.CODE_LENGTH} characters shown on the other device.`);
      $('#codeInput').focus();
      return;
    }

    setJoinBusy(true);
    setStatus('connecting');

    try {
      const session = await Rendezvous.deriveSession(code);

      state.connection = new Peer.Connection(connectionHandlers({
        onOpen: (channel) => onReceiverChannelOpen(channel),
        onMessage: (data) => state.receiver?.handleMessage(data),
      }));

      let handled = false;
      state.unsubscribe = Rendezvous.subscribe(session, async (payload) => {
        if (handled) return;
        const offer = await Rendezvous.unseal(session, Rendezvous.ROLE_OFFER, payload);
        if (!offer) return;
        handled = true;
        clearTimeout(state.waitTimer);
        state.unsubscribe?.();
        state.unsubscribe = null;

        try {
          const answer = await state.connection.acceptOfferAndAnswer(offer);
          await Rendezvous.publish(session, await Rendezvous.seal(session, Rendezvous.ROLE_ANSWER, answer));
          setStatus('connecting');
        } catch (err) {
          setStatus('error');
          setJoinBusy(false);
          showRecvError(err.message || 'That code did not work.');
        }
      }, (err) => Util.toast(err.message, 'warn', 5000));

      // No sender on this topic? Almost always a mistyped code.
      state.waitTimer = setTimeout(() => {
        if (handled) return;
        state.unsubscribe?.();
        state.unsubscribe = null;
        state.connection?.close();
        state.connection = null;
        setStatus('error');
        setJoinBusy(false);
        showRecvError('No device is waiting with that code. Check the code and make sure the other page is still open.');
      }, OFFER_WAIT_MS);
    } catch (err) {
      setStatus('error');
      setJoinBusy(false);
      showRecvError(err.message || 'Could not connect.');
      state.connection?.close();
      state.connection = null;
    }
  }

  function onReceiverChannelOpen(channel) {
    setStatus('connected');
    Util.vibrate(40);
    $('#recvStageCode').hidden = true;
    $('#recvStageLinked').hidden = false;
    $('#recvTransferPanel').hidden = false;
    Util.toast('Connected. Waiting for files…', 'ok');

    state.receiver = new Transfer.Receiver(channel, {
      onText: (id, body) => {
        $('#recvIdleHint').hidden = true;
        state.recvTextCount++;
        textRow('#recvTransfers', body, 'Received');
        Util.toast('Message received.', 'ok', 4000);
        Util.vibrate(40);
      },
      onFileStart: (id, info) => {
        $('#recvIdleHint').hidden = true;
        $('#cancelRecvBtn').hidden = false;
        setStatus('receiving');
        transferRow('#recvTransfers', id, info.name, info.size);
      },
      onProgress: (id, info) => updateRow(id, info),
      onFileComplete: (id, blob, name, mime) => {
        state.recvFileCount++;
        addSaveActions(id, blob, name, mime);
        Util.toast(`"${name}" received — ${Util.formatBytes(blob.size)}.`, 'ok', 5000);
        Util.vibrate([40, 60, 40]);
      },
      onAllDone: () => {
        setStatus('complete');
        $('#cancelRecvBtn').hidden = true;
        if (state.recvFileCount > 0) {
          Util.toast('All files received. Use the Save buttons to keep them.', 'ok', 6000);
        }
      },
      onRemoteCancel: () => {
        setStatus('error');
        $('#cancelRecvBtn').hidden = true;
        Util.toast('The sender cancelled the transfer.', 'warn', 5000);
      },
      onError: (err) => Util.toast(err.message, 'error', 6000),
    });
  }

  /* ---- event wiring ---- */

  function wireNav() {
    document.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const target = btn.dataset.nav;
        if (target === 'home') goHome();
        else if (target === 'send') { teardown(); show('#screen-send'); setStatus('idle'); }
        else if (target === 'receive') {
          teardown();
          show('#screen-receive');
          setStatus('idle');
          $('#codeInput').focus();
        }
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

    // A message alone is enough to enable sending, so track it too.
    $('#messageInput').addEventListener('input', updateSendReady);
  }

  function wireCodeEntry() {
    const input = $('#codeInput');

    // Show the code the same way we display it, without fighting the caret.
    input.addEventListener('input', () => {
      const raw = Rendezvous.normalizeCode(input.value).slice(0, Rendezvous.CODE_LENGTH);
      const atEnd = input.selectionStart === input.value.length;
      input.value = raw.length > 3 ? Rendezvous.formatCode(raw) : raw;
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
      showRecvError('');
    });

    $('#codeForm').addEventListener('submit', (event) => {
      event.preventDefault();
      joinWithCode();
    });

    $('#copyCodeBtn').addEventListener('click', async () => {
      const ok = await Util.copyText($('#codeValue').textContent);
      Util.toast(ok ? 'Code copied.' : 'Could not copy — read it out instead.', ok ? 'ok' : 'warn', 2500);
    });
  }

  function wireActions() {
    $('#createCodeBtn').addEventListener('click', createCode);
    $('#startSendBtn').addEventListener('click', startSending);

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

    window.addEventListener('beforeunload', (event) => {
      if (state.sender?.active || state.receiver?.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    window.addEventListener('pagehide', () => {
      state.unsubscribe?.();
      state.connection?.close();
    });
  }

  /* ---- boot ---- */

  function init() {
    const problem = Peer.checkSupport()
      || (!Rendezvous.isSupported()
        ? 'This browser is missing the crypto features Beam needs to exchange codes safely. Try a newer version.'
        : null);

    if (problem) {
      const note = $('#compatNote');
      note.textContent = problem;
      note.hidden = false;
      document.querySelectorAll('.choice-card').forEach((card) => { card.disabled = true; });
      show('#screen-home');
      return;
    }

    wireNav();
    wireDropzone();
    wireCodeEntry();
    wireActions();
    show('#screen-home');
    setStatus('idle');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
