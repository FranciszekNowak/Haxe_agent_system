// Haxe zip-extractor service (ADR-058 — zip extraction moved off the n8n worker).
//
// WHY: the n8n reader's `Decompress` node (adm-zip) inflates a whole archive into the
// worker's 768 MB heap at once. A >500 MB zip OOM-kills the shared queue worker and takes
// every co-running execution down with it (the 2026-06-24 07:30 CRITICAL cascade). This
// service does the extraction OFF the worker: it streams the zip to local disk, walks it
// entry-by-entry (yauzl, never the whole archive in RAM), uploads each accepted entry to the
// Supabase bucket, and returns a manifest. The n8n reader then just fans the manifest into its
// existing image/document/drop paths — it never decompresses anything.
//
// CONTRACT
//   POST /extract
//     { url, task_id, attachment_id, parent_title?,
//       caps?: { max_entries, max_file_mb, max_total_mb },     // caps single-sourced from n8n config
//       manifest_only?: bool,    // ADR-061 Block 2c: walk the central directory only — names/sizes/
//                                //   types/routes, NO openReadStream / upload / sign. Cheap index.
//       only_index?: number }    // ADR-061 Block 2c: materialize ONLY the entry at this index
//                                //   (read+upload+sign just that one); other entries are walked for
//                                //   cap accounting + index stability but not returned.
//   -> 200 { ok:true, entries: [ {
//            index, name, ext, mime, size, route: 'image'|'document'|'drop',
//            att_id, storage_path?, signed_url?, stored?, drop_reason?, warn_source? } ] }
//   -> 200 with a single zip_extraction_failed drop  : corrupt/unreadable archive (graceful)
//   -> 400 { ok:false, error }                       : bad request (only_index not a non-neg integer)
//   -> 502 { ok:false, error }                       : infra failure (download/unexpected) -> n8n escalates
//   GET /health -> 200 { ok:true }
//
//   INDEX STABILITY (Block 2c invariant): an entry's `index` is assigned to EVERY non-junk entry in
//   archive order, BEFORE any cap check, so it is independent of caps and of mode. The same physical
//   entry therefore carries the same `<attId>:<index>` across manifest_only, only_index, and full
//   materialize-all walks — `list_attachments` (manifest) and `get_attachment("<zip>:<idx>")` (single
//   materialize, via the n8n reader) always agree on which file an index refers to. Junk
//   (directories, __MACOSX, dotfiles) is skipped WITHOUT consuming an index, identically in all modes.
//
// Drop taxonomy + warn_source strings mirror the reader's old `Explode Zip Entries` node so the
// downstream `Build Dropped Zip Block` / alerting paths are unchanged.

import express from 'express';
import yauzl from 'yauzl';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  BUCKET = 'zip-inner-images',
  PORT = '8080',
  SIGN_TTL = '21600', // 6 h, mirrors the reader's Sign Zip Image URL node
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  process.exit(1);
}

// Mirror the reader's Explode Zip Entries image set; everything else routes to 'document'.
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'tif', 'heic', 'heif']);
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/markdown',
  json: 'application/json', xml: 'application/xml',
};
const MB = 1024 * 1024;

const extOf = (name) => {
  const b = String(name).toLowerCase().split('/').pop();
  return b.includes('.') ? b.split('.').pop() : '';
};
// Same sanitization as the reader's Zip Image Key node.
const sanitize = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_');

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}

// Read a single entry stream into a buffer, aborting if it exceeds the per-file cap.
function collect(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on('data', (c) => {
      n += c.length;
      if (n > max) { stream.destroy(); reject(new Error('entry exceeds per-file cap during read')); return; }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function uploadAndSign(storagePath, buf, mime) {
  const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY };
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { ...headers, 'x-upsert': 'true', 'Content-Type': mime, 'cache-control': 'max-age=3600' },
    body: buf,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text().catch(() => '')}`);
  const sg = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: Number(SIGN_TTL) }),
  });
  if (!sg.ok) throw new Error(`sign ${sg.status}`);
  const j = await sg.json();
  const signed = j.signedURL || (j.body && j.body.signedURL) || '';
  return signed ? `${SUPABASE_URL}/storage/v1${signed}` : '';
}

// Walk the archive entry-by-entry. Peak heap ~= one entry (bounded by per-file cap), never the
// whole archive. Returns { ok, entries } or { ok:false } on a corrupt/unreadable archive.
//
// ONE shared walk serves all three modes (ADR-061 Block 2c) — the accept/drop classification, the
// cap accounting, and the index numbering are byte-for-byte identical; only the per-entry SIDE EFFECT
// (read stream -> upload -> sign) differs:
//   - full materialize (manifestOnly=false, onlyIndex=null): materialize every accepted entry.
//   - manifest_only=true: emit metadata for every entry (drop+accept), NEVER read/upload/sign.
//   - only_index=N: walk all entries for cap/index accounting, but materialize + RETURN only index N.
// `index` is assigned to every non-junk entry before the cap checks, so it never depends on caps or
// mode — that is what makes a manifest index a valid argument to a later single-entry pull.
function processZip(zipPath, ctx) {
  const { maxEntries, maxFileMb, maxTotalMb, taskId, attId, parentTitle, manifestOnly, onlyIndex } = ctx;
  const single = onlyIndex != null;              // single-entry materialize mode
  const wanted = (i) => manifestOnly || !single || i === onlyIndex; // include this index in the result?
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { resolve({ ok: false }); return; }
      const entries = [];
      let index = 0;          // next entry index — advances for EVERY non-junk entry (drop or accept)
      let accepted = 0;
      let totalBytes = 0;
      const drop = (i, name, reason, ws) => { if (wanted(i)) entries.push({ index: i, name, ext: extOf(name), route: 'drop', att_id: `${attId}:${i}`, drop_reason: reason, warn_source: ws }); };
      // single-mode finished with nothing -> a structured "inner index not found" drop so the n8n
      // reader still gets one item (never a 0-item zip branch that nulls the pipeline) and the agent
      // sees a clear signal (mirrors Block 2's bogus-attachment-id path).
      const finish = () => {
        if (single && entries.length === 0) entries.push({ index: onlyIndex, name: parentTitle, ext: 'zip', route: 'drop', att_id: `${attId}:${onlyIndex}`, drop_reason: 'inner_index_not_found', warn_source: 'multimodal/zip-inner-not-found' });
        resolve({ ok: true, entries });
      };

      zip.on('error', () => (entries.length ? finish() : resolve({ ok: false })));
      zip.on('end', finish);
      zip.readEntry();
      zip.on('entry', async (entry) => {
        let i = null;
        try {
          const name = entry.fileName;
          const lname = name.toLowerCase();
          const base = lname.split('/').pop();
          // junk: directories, __MACOSX, dotfiles — silently skipped (no index consumed, all modes)
          if (lname.endsWith('/') || lname.includes('__macosx') || base.startsWith('.') || base === '') return zip.readEntry();

          i = index++;                            // this entry's stable index (cap- and mode-independent)
          const ext = extOf(name);
          const mime = MIME[ext] || 'application/octet-stream';
          if (ext === 'zip') { drop(i, name, 'nested_zip', 'multimodal/zip-nested-skipped'); return zip.readEntry(); }
          if (accepted >= maxEntries) { drop(i, name, 'too_many_entries', 'multimodal/zip-too-large'); return zip.readEntry(); }

          const size = entry.uncompressedSize;
          if (size > maxFileMb * MB) { drop(i, name, `oversize_${Math.round(size / MB)}mb`, 'multimodal/zip-too-large'); return zip.readEntry(); }
          if (totalBytes + size > maxTotalMb * MB) { drop(i, name, 'over_total_uncompressed', 'multimodal/zip-too-large'); return zip.readEntry(); }

          // accepted entry — account for caps in every mode (keeps too_many/over_total decisions, and
          // therefore the drop/accept routes, identical across manifest and materialize walks).
          accepted++;
          totalBytes += size;
          const route = mime.startsWith('image/') || IMG_EXT.has(ext) ? 'image' : 'document';
          const entryAttId = `${attId}:${i}`;
          if (!wanted(i)) return zip.readEntry();              // counted, not returned (single-mode skip)
          if (manifestOnly) { entries.push({ index: i, name, ext, mime, size, route, att_id: entryAttId }); return zip.readEntry(); }

          // materialize: full mode (every accepted entry) or single mode (only the matching index)
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
          const buf = await collect(stream, maxFileMb * MB);
          const storagePath = `${taskId}/${sanitize(entryAttId)}`;
          let ref = '';
          try { ref = await uploadAndSign(storagePath, buf, mime); } catch { ref = ''; }
          entries.push({ index: i, name, ext, mime, size, route, att_id: entryAttId, storage_path: storagePath, signed_url: ref, stored: !!ref });
          return zip.readEntry();
        } catch {
          // a single bad entry degrades to a drop (only read/upload throw here -> i is already set);
          // the rest of the archive still processes
          drop(i == null ? index : i, entry.fileName || parentTitle, 'entry_read_failed', 'multimodal/zip-extraction-failed');
          return zip.readEntry();
        }
      });
    });
  });
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/extract', async (req, res) => {
  const { url, task_id, attachment_id, parent_title, caps, manifest_only, only_index } = req.body || {};
  if (!url || !task_id) return res.status(400).json({ ok: false, error: 'url and task_id are required' });
  let onlyIndex = null;
  if (only_index !== undefined && only_index !== null && only_index !== '') {
    onlyIndex = Number(only_index);
    if (!Number.isInteger(onlyIndex) || onlyIndex < 0) return res.status(400).json({ ok: false, error: 'only_index must be a non-negative integer' });
  }
  const ctx = {
    taskId: task_id,
    attId: attachment_id || 'zip',
    parentTitle: parent_title || 'archive.zip',
    maxEntries: Number(caps?.max_entries) || 50,
    maxFileMb: Number(caps?.max_file_mb) || 25,
    maxTotalMb: Number(caps?.max_total_mb) || 250,
    manifestOnly: !!manifest_only,
    onlyIndex,
  };
  const tmp = path.join(os.tmpdir(), `zip-${task_id}-${sanitize(attachment_id || 'x')}-${process.hrtime.bigint()}.zip`);
  try {
    await download(url, tmp);
    const result = await processZip(tmp, ctx);
    if (!result.ok) {
      // corrupt / unreadable archive -> graceful single drop (run continues, WARN fires)
      return res.json({ ok: true, entries: [{ index: 0, name: ctx.parentTitle, route: 'drop', att_id: `${ctx.attId}:x`, drop_reason: 'zip_extraction_failed', warn_source: 'multimodal/zip-extraction-failed' }] });
    }
    return res.json({ ok: true, entries: result.entries });
  } catch (e) {
    // infra failure (download/unexpected) -> 502 so n8n's onError escalates
    return res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    fs.rm(tmp, { force: true }).catch(() => {});
  }
});

// Only bind the port when run as the entrypoint; importing this module (e.g. the Block 2c walk
// test) must not start the server.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) app.listen(Number(PORT), () => console.log(`zip-extractor listening on :${PORT}, bucket=${BUCKET}`));

export { processZip };
