/* DICOM Facile — conversione DICOM → JPG/PDF interamente nel browser. */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const PDF_MAX_PX = 1600;   // lato massimo delle immagini dentro il PDF
  const GRID_FROM = 7;       // serie con almeno 7 immagini → mosaico 3x3 nel PDF
  const GALLERY_PAGE = 60;   // miniature mostrate subito per serie

  const SKIP_EXT = new Set(('exe dll html htm js css inf ini txt xml json jar class png jpg jpeg gif ico bmp ' +
    'cab msi bat cmd sys ocx chm lnk plist ds_store zip rar 7z mp4 avi mov sh app dylib dmg pkg md csv ' +
    'rtf doc docx xls xlsx url ttf otf woff woff2 swf manifest dat db log').split(' '));
  const TS_UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99']);
  const TS_RLE = '1.2.840.10008.1.2.5';
  const TS_JPEG_BASELINE = '1.2.840.10008.1.2.4.50';
  const MODALITY_IT = {
    CT: 'TC', MR: 'Risonanza magnetica', US: 'Ecografia', CR: 'Radiografia', DX: 'Radiografia',
    DR: 'Radiografia', MG: 'Mammografia', NM: 'Medicina nucleare', PT: 'PET', XA: 'Angiografia',
    RF: 'Radioscopia', OT: 'Immagine', SC: 'Immagine', ES: 'Endoscopia', OP: 'Fotografia oculare',
    OPT: 'OCT', IO: 'Radiografia dentale', PX: 'Panoramica dentale', SEG: 'Segmentazione',
  };

  daikon.Image.skipPaletteConversion = true; // la palette la gestiamo noi (endianness corretta)

  const ui = {
    start: $('#start'), working: $('#working'), result: $('#result'),
    bar: $('#bar'), workTitle: $('#workTitle'), workDetail: $('#workDetail'),
    fileInput: $('#fileInput'), dirInput: $('#dirInput'), pick: $('#pick'), pickDir: $('#pickDir'),
    drop: $('#drop'), showName: $('#showName'),
  };

  let current = null; // risultato dell'ultima conversione
  let objectUrls = [];

  // ------------------------------------------------------------------ utilità

  // cede il controllo al browser (aggiorna la barra di avanzamento) senza i ritardi minimi di setTimeout
  const yieldChannel = new MessageChannel();
  const yieldQueue = [];
  yieldChannel.port1.onmessage = () => { const r = yieldQueue.shift(); if (r) r(); };
  const tick = () => new Promise((r) => { yieldQueue.push(r); yieldChannel.port2.postMessage(0); });

  function tagValue(img, group, element) {
    const tag = img.getTag(group, element);
    return tag && tag.value != null ? tag.value : null;
  }

  function tagText(img, group, element) {
    const v = tagValue(img, group, element);
    if (v == null) return '';
    // daikon converte le date (DA) in oggetti Date: le riportiamo al formato DICOM AAAAMMGG
    const one = (x) => (x instanceof Date
      ? (Number.isNaN(x.getTime()) ? '' : `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}`)
      : (typeof x === 'string' || typeof x === 'number' ? String(x) : ''));
    const s = Array.isArray(v) ? v.map(one).join(' ') : one(v);
    return s.replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function tagNumber(img, group, element) {
    const v = tagValue(img, group, element);
    const n = parseFloat(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtDate(s) {
    return /^\d{8}$/.test(s || '') ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : (s || '');
  }

  function safeName(s, fallback) {
    const out = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\- ]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^[_ ]+|[_ ]+$/g, '');
    return (out || fallback).slice(0, 45);
  }

  function pad(n, w = 2) { return String(n).padStart(w, '0'); }

  function track(url) { objectUrls.push(url); return url; }

  function canvasToBlob(canvas, quality = 0.92) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('conversione JPG non riuscita'))), 'image/jpeg', quality);
    });
  }

  async function isZip(file) {
    if (/\.zip$/i.test(file.name)) return true;
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    } catch { return false; }
  }

  // ------------------------------------------------------------------ raccolta file

  async function expand(files) {
    const entries = [];
    for (const file of files) {
      if (await isZip(file)) {
        setWork('Apro il file .zip…', 0, file.name);
        const zip = await JSZip.loadAsync(file);
        zip.forEach((path, entry) => {
          if (!entry.dir) entries.push({ name: path, read: () => entry.async('arraybuffer') });
        });
      } else {
        entries.push({ name: file.relPath || file.webkitRelativePath || file.name, read: () => file.arrayBuffer() });
      }
    }
    return entries;
  }

  async function filesFromDrop(dataTransfer) {
    const roots = [...dataTransfer.items]
      .filter((it) => it.kind === 'file')
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!roots.length) return [...dataTransfer.files];
    const files = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file.relPath = path + file.name;
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child, `${path}${entry.name}/`);
        }
      }
    };
    for (const root of roots) await walk(root, '');
    return files;
  }

  // ------------------------------------------------------------------ decodifica

  function looksLikeDicom(img, buffer) {
    const bytes = new Uint8Array(buffer, 128, Math.min(4, Math.max(0, buffer.byteLength - 128)));
    const hasPreamble = bytes.length === 4 && String.fromCharCode(...bytes) === 'DICM';
    return hasPreamble || tagValue(img, 0x0008, 0x0016) != null || tagValue(img, 0x0008, 0x0018) != null;
  }

  function metaOf(img) {
    const modality = tagText(img, 0x0008, 0x0060);
    return {
      patient: tagText(img, 0x0010, 0x0010),
      studyUid: tagText(img, 0x0020, 0x000d),
      studyDate: tagText(img, 0x0008, 0x0020),
      studyDesc: tagText(img, 0x0008, 0x1030),
      institution: tagText(img, 0x0008, 0x0080),
      seriesUid: tagText(img, 0x0020, 0x000e),
      seriesNumber: tagNumber(img, 0x0020, 0x0011),
      seriesDesc: tagText(img, 0x0008, 0x103e),
      seriesDate: tagText(img, 0x0008, 0x0021),
      instance: tagNumber(img, 0x0020, 0x0013),
      modality,
    };
  }

  function grayWindow(values, min, max, img) {
    const wc = tagNumber(img, 0x0028, 0x1050);
    const ww = tagNumber(img, 0x0028, 0x1051);
    if (wc != null && ww != null && ww > 1) return [wc - ww / 2, wc + ww / 2];
    if (max <= min) return [min, min + 1];
    // percentili 0,5% – 99,5% tramite istogramma
    const bins = 4096;
    const hist = new Uint32Array(bins);
    const scale = (bins - 1) / (max - min);
    for (let i = 0; i < values.length; i++) hist[((values[i] - min) * scale) | 0]++;
    const lowCount = values.length * 0.005;
    const highCount = values.length * 0.995;
    let acc = 0; let lo = min; let hi = max; let loSet = false;
    for (let b = 0; b < bins; b++) {
      acc += hist[b];
      if (!loSet && acc >= lowCount) { lo = min + b / scale; loSet = true; }
      if (acc >= highCount) { hi = min + (b + 1) / scale; break; }
    }
    return hi > lo ? [lo, hi] : [min, max];
  }

  // JPEG baseline 8 bit: decodifica nativa del browser (più veloce, e gestisce bene i JPEG RGB "senza trasformazione")
  function jpegHasColorMarker(bytes) {
    // APP0 (JFIF) o APP14 (Adobe) prima dei dati: dicono al decoder come gestire il colore
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xFF) {
      const m = bytes[i + 1];
      if (m === 0xDA) break;
      if (m === 0xE0 || m === 0xEE) return true;
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    return false;
  }

  async function nativeJpegFrame(bytes, spp, n, photo) {
    // JPEG senza marcatori e con Photometric RGB: i dati sono già RGB, ma il browser li tratta come
    // YCbCr. In quel caso annulliamo la conversione fatta dal browser.
    const undoYcc = spp === 3 && photo === 'RGB' && !jpegHasColorMarker(bytes);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    if (c.width * c.height !== n) throw new Error('dimensioni JPEG diverse da quelle dichiarate');
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8Array(n * spp);
    if (spp === 1) {
      for (let i = 0; i < n; i++) out[i] = d[i * 4];
    } else if (undoYcc) {
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
        const r = d[j]; const g = d[j + 1]; const b = d[j + 2];
        out[k] = 0.299 * r + 0.587 * g + 0.114 * b + 0.5;
        out[k + 1] = Math.min(255, Math.max(0, -0.168736 * r - 0.331264 * g + 0.5 * b + 128.5));
        out[k + 2] = Math.min(255, Math.max(0, 0.5 * r - 0.418688 * g - 0.081312 * b + 128.5));
      }
    } else {
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) { out[k] = d[j]; out[k + 1] = d[j + 1]; out[k + 2] = d[j + 2]; }
    }
    return new DataView(out.buffer);
  }

  async function decodeImage(img, onFrame) {
    const rows = img.getRows();
    const cols = img.getCols();
    const spp = img.getNumberOfSamplesPerPixel() || 1;
    const bitsAlloc = img.getBitsAllocated() || 16;
    const bitsStored = Math.min(img.getBitsStored() || bitsAlloc, bitsAlloc);
    const signed = img.getPixelRepresentation() === 1;
    const photo = String(img.getPhotometricInterpretation() || 'MONOCHROME2').trim().toUpperCase();
    const ts = String(img.getTransferSyntax() || '').trim();
    const compressed = img.isCompressed();
    if (!rows || !cols || !img.getPixelData()) throw new Error('dati immagine mancanti');

    const n = rows * cols;
    const bpb = Math.max(1, Math.ceil(bitsAlloc / 8));
    const isPalette = photo === 'PALETTE COLOR';
    const ybr422Raw = photo === 'YBR_FULL_422' && TS_UNCOMPRESSED.has(ts);
    const isYbr = photo.startsWith('YBR') && (TS_UNCOMPRESSED.has(ts) || ts === TS_RLE);
    const planar = spp === 3 && img.getPlanarConfig() === 1 && !compressed;
    const frameLen = ybr422Raw ? n * 2 * bpb : n * spp * bpb;
    const declared = Math.max(1, img.getNumberOfFrames() || 1);

    // sorgente dei pixel: decodifica nativa (JPEG baseline) oppure i decodificatori di daikon
    let jpegs = null;
    if (ts === TS_JPEG_BASELINE && bitsAlloc === 8 && typeof createImageBitmap === 'function') {
      try { jpegs = img.getJpegs(); } catch { jpegs = null; }
    }
    let shared = null; let sharedLe = true;
    const useDaikon = () => {
      jpegs = null;
      img.getPixelDataBytes(); // forza la decompressione
      shared = img.getPixelData().value;
      sharedLe = compressed ? true : img.littleEndian;
    };
    if (!jpegs || !jpegs.length) useDaikon();

    const available = jpegs ? jpegs.length
      : bitsAlloc === 1 ? Math.floor((shared.byteLength * 8) / n) : Math.floor(shared.byteLength / frameLen);
    const nFrames = Math.min(declared, available);
    if (nFrames < 1) throw new Error('dati immagine incompleti');

    const frameSource = async (f) => {
      if (jpegs) {
        try {
          return { view: await nativeJpegFrame(new Uint8Array(jpegs[f]), spp, n, photo), base: 0, le: true };
        } catch (e) {
          if (f > 0) throw e;
          useDaikon(); // il browser non ce l'ha fatta: riprovo con il decodificatore JavaScript
        }
      }
      return { view: shared, base: f * frameLen, le: sharedLe };
    };

    const canvas = document.createElement('canvas');
    canvas.width = cols; canvas.height = rows;
    const ctx = canvas.getContext('2d');

    for (let f = 0; f < nFrames; f++) {
      const { view, base, le } = await frameSource(f);
      const read = bpb === 1 ? (o) => view.getUint8(o)
        : bpb === 2 ? (o) => view.getUint16(o, le)
          : (o) => view.getUint32(o, le);
      const out = ctx.createImageData(cols, rows);
      const px = out.data;

      if (spp === 1 && !isPalette) {
        let rawAt;
        if (bitsAlloc === 1) { // immagini a 1 bit (es. segmentazioni): bit impacchettati
          const bitBase = f * n;
          rawAt = (i) => (view.getUint8((bitBase + i) >> 3) >> ((bitBase + i) & 7)) & 1;
        } else {
          rawAt = (i) => read(base + i * bpb);
        }
        const slope = img.getDataScaleSlope() || 1;
        const intercept = img.getDataScaleIntercept() || 0;
        const vals = new Float32Array(n);
        const bits = Math.min(bitsStored, 32);
        const range = 2 ** bits;
        let min = Infinity; let max = -Infinity;
        for (let i = 0; i < n; i++) {
          let raw = rawAt(i);
          if (bits < 32) raw %= range;
          if (signed && raw >= range / 2) raw -= range;
          const v = raw * slope + intercept;
          vals[i] = v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const [lo, hi] = grayWindow(vals, min, max, img);
        const k = 255 / (hi - lo);
        const invert = photo === 'MONOCHROME1';
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          let g = (vals[i] - lo) * k;
          g = g < 0 ? 0 : g > 255 ? 255 : g;
          if (invert) g = 255 - g;
          px[j] = px[j + 1] = px[j + 2] = g; px[j + 3] = 255;
        }
      } else if (isPalette) {
        const desc = tagValue(img, 0x0028, 0x1101);
        const first = Array.isArray(desc) ? Number(desc[1]) || 0 : 0;
        const R = img.getPalleteValues(daikon.Tag.TAG_PALETTE_RED) || [];
        const G = img.getPalleteValues(daikon.Tag.TAG_PALETTE_GREEN) || [];
        const B = img.getPalleteValues(daikon.Tag.TAG_PALETTE_BLUE) || [];
        const last = Math.max(0, R.length - 1);
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          let idx = read(base + i * bpb) - first;
          idx = idx < 0 ? 0 : idx > last ? last : idx;
          px[j] = R[idx]; px[j + 1] = G[idx]; px[j + 2] = B[idx]; px[j + 3] = 255;
        }
      } else {
        const shift = bpb === 2 ? Math.max(0, bitsStored - 8) : 0;
        const sample = (o) => (shift ? read(o) >> shift : read(o));
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          let a; let b; let c;
          if (ybr422Raw) {
            const pair = base + Math.floor(i / 2) * 4 * bpb;
            a = sample(pair + (i % 2) * bpb); b = sample(pair + 2 * bpb); c = sample(pair + 3 * bpb);
          } else if (planar) {
            a = sample(base + i * bpb); b = sample(base + (n + i) * bpb); c = sample(base + (2 * n + i) * bpb);
          } else {
            const o = base + i * 3 * bpb;
            a = sample(o); b = sample(o + bpb); c = sample(o + 2 * bpb);
          }
          if (isYbr || ybr422Raw) {
            const cb = b - 128; const cr = c - 128;
            px[j] = a + 1.402 * cr;
            px[j + 1] = a - 0.344136 * cb - 0.714136 * cr;
            px[j + 2] = a + 1.772 * cb;
          } else {
            px[j] = a; px[j + 1] = b; px[j + 2] = c;
          }
          px[j + 3] = 255;
        }
      }
      ctx.putImageData(out, 0, 0);
      // un fotogramma alla volta: il canvas viene riusato, così la memoria resta bassa anche con i video
      await onFrame(canvas, f, nFrames);
    }
    return nFrames;
  }

  function scaled(canvas, maxPx) {
    const s = Math.min(1, maxPx / Math.max(canvas.width, canvas.height));
    if (s >= 1) return canvas;
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  function pdfFrameIndexes(count) {
    if (count <= 12) return new Set([...Array(count).keys()]);
    const step = Math.max(1, Math.floor(count / 8));
    const keep = new Set([0, count - 1]);
    for (let i = step; i < count; i += step) keep.add(i);
    return keep;
  }

  // ------------------------------------------------------------------ conversione

  async function convert(files) {
    show('working');
    setWork('Preparo i file…', 0, '');
    const entries = (await expand(files)).filter((e) => {
      const base = e.name.split('/').pop();
      return !e.name.startsWith('__MACOSX/') && !base.startsWith('._') && base !== '.DS_Store';
    });

    const records = [];
    const reports = [];
    const errors = [];
    let skipped = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const base = entry.name.split('/').pop();
      const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
      setWork(`Converto il file ${i + 1} di ${entries.length}`, i / entries.length, entry.name);
      await tick();

      if (ext === 'pdf') {
        const buf = await entry.read();
        reports.push({ name: base, blob: new Blob([buf], { type: 'application/pdf' }) });
        continue;
      }
      if (SKIP_EXT.has(ext) || base.toUpperCase() === 'DICOMDIR') { skipped++; continue; }

      let buffer;
      try { buffer = await entry.read(); } catch (e) { errors.push(`${base}: non leggibile`); continue; }
      if (buffer.byteLength < 64) { skipped++; continue; }

      let img = null;
      try { img = daikon.Series.parseImage(new DataView(buffer)); } catch { img = null; }
      if (!img || !looksLikeDicom(img, buffer)) { skipped++; continue; }

      const docTag = img.getTag(0x0042, 0x0011);
      if (docTag) {
        // daikon prova a interpretare il contenuto come dati DICOM: prendiamo i byte grezzi dal file
        let bytes = docTag.value instanceof DataView
          ? new Uint8Array(docTag.value.buffer, docTag.value.byteOffset, docTag.value.byteLength)
          : new Uint8Array(buffer.slice(docTag.offsetValue, docTag.offsetEnd));
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) end--;
        bytes = bytes.slice(0, end);
        const title = tagText(img, 0x0042, 0x0010) || tagText(img, 0x0008, 0x103e) || 'Referto';
        const date = tagText(img, 0x0008, 0x0023) || tagText(img, 0x0008, 0x0020);
        const mime = tagText(img, 0x0042, 0x0012) || 'application/pdf';
        const ext = /pdf/i.test(mime) ? 'pdf' : /xml/i.test(mime) ? 'xml' : 'bin';
        reports.push({ name: `${safeName(title, 'Referto')}${date ? `_${date}` : ''}.${ext}`, blob: new Blob([bytes], { type: mime }) });
        continue;
      }

      const rows = img.getRows(); const cols = img.getCols();
      if (!rows || !cols || !img.getPixelData() || rows > 30000 || cols > 30000) {
        if (tagText(img, 0x0008, 0x0060) === 'SR') errors.push(`${base}: referto strutturato (SR), non convertibile qui`);
        else skipped++;
        continue;
      }

      try {
        const meta = metaOf(img);
        const out = [];
        let inPdf = null;
        await decodeImage(img, async (canvas, f, total) => {
          if (!inPdf) inPdf = pdfFrameIndexes(total);
          const blob = await canvasToBlob(canvas);
          let pdf = null;
          if (inPdf.has(f)) {
            const small = scaled(canvas, PDF_MAX_PX);
            pdf = { blob: small === canvas ? blob : await canvasToBlob(small, 0.88), w: small.width, h: small.height };
          }
          out.push({ blob, w: canvas.width, h: canvas.height, pdf, label: total > 1 ? `fotogramma ${f + 1}/${total}` : '' });
          if (total > 1) setWork(`Converto il file ${i + 1} di ${entries.length}`, i / entries.length, `${entry.name} · fotogramma ${f + 1}/${total}`);
          if (f % 4 === 3) await tick();
        });
        records.push({ meta, name: entry.name, frames: out });
      } catch (e) {
        errors.push(`${base}: ${e && e.message ? e.message : 'formato non supportato'}`);
      }
      buffer = null; img = null;
    }

    if (!records.length && !reports.length) {
      show('start');
      alert(entries.length
        ? 'Non ho trovato immagini DICOM tra i file scelti. Prova a scegliere il file .zip con tutta la cartella dell\'esame.'
        : 'Nessun file selezionato.');
      return;
    }

    const series = groupSeries(records);
    setWork('Creo il PDF…', 0.98, '');
    await tick();
    const showName = ui.showName.checked;
    const pdfBlob = await buildPdf(series, reports, showName);
    current = { series, reports, errors, skipped, pdfBlob, pdfName: pdfFileName(series, showName) };
    renderResult(current);
  }

  function groupSeries(records) {
    const map = new Map();
    for (const r of records) {
      const key = r.meta.seriesUid || `cartella:${r.name.split('/').slice(0, -1).join('/')}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const series = [...map.values()].map((items) => {
      items.sort((a, b) => ((a.meta.instance ?? 1e9) - (b.meta.instance ?? 1e9)) || a.name.localeCompare(b.name));
      const m = items[0].meta;
      const frames = items.flatMap((it) => it.frames);
      return {
        meta: m,
        number: m.seriesNumber,
        desc: m.seriesDesc || m.studyDesc || MODALITY_IT[m.modality] || 'Serie',
        modality: m.modality,
        date: m.seriesDate || m.studyDate,
        frames,
      };
    });
    series.sort((a, b) => (a.meta.studyDate || '').localeCompare(b.meta.studyDate || '')
      || (a.number ?? 1e9) - (b.number ?? 1e9) || a.desc.localeCompare(b.desc));
    series.forEach((s, i) => { s.order = i + 1; if (s.number == null) s.number = i + 1; });
    return series;
  }

  function pdfFileName(series, showName) {
    const m = series[0] ? series[0].meta : {};
    const who = showName && m.patient ? `_${safeName(m.patient, '').replace(/ /g, '_')}` : '';
    const when = m.studyDate ? `_${m.studyDate}` : '';
    return `Immagini_esame${who}${when}.pdf`;
  }

  // ------------------------------------------------------------------ PDF

  async function buildPdf(series, reports, showName) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = 210; const H = 297; const M = 14;
    let page = 1;

    const footer = () => {
      doc.setDrawColor(200); doc.setLineWidth(0.3); doc.line(M, H - 14, W - M, H - 14);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text('Immagini convertite dai file DICOM originali, a scopo di visualizzazione.', M, H - 9);
      doc.text(`pag. ${page}`, W - M, H - 9, { align: 'right' });
    };
    const newPage = () => { doc.addPage(); page++; };

    // copertina
    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(20);
    doc.text('Immagini esame diagnostico', M, M + 10);
    let y = M + 24;
    const row = (label, value) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(90);
      doc.text(label, M, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(20);
      const lines = doc.splitTextToSize(value, W - 2 * M - 30);
      doc.text(lines, M + 30, y);
      y += 6 * lines.length + 2;
    };
    const patients = [...new Set(series.map((s) => s.meta.patient).filter(Boolean))];
    if (showName && patients.length) row('Paziente', patients.join(', '));
    const studies = [];
    for (const s of series) {
      const k = [fmtDate(s.meta.studyDate), s.meta.studyDesc, s.meta.institution].filter(Boolean).join(' – ');
      if (k && !studies.includes(k)) studies.push(k);
    }
    for (const st of studies) row('Esame', st);

    y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(20);
    doc.text('Serie contenute', M, y); y += 8;
    const cols = [M, M + 16, M + 34, W - M];
    const tableHead = () => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(90);
      doc.text('N.', cols[0], y); doc.text('Tipo', cols[1], y); doc.text('Descrizione', cols[2], y);
      doc.text('Immagini', cols[3], y, { align: 'right' });
      y += 2; doc.setDrawColor(180); doc.line(M, y, W - M, y); y += 5;
    };
    tableHead();
    doc.setFont('helvetica', 'normal'); doc.setTextColor(20);
    for (const s of series) {
      if (y > H - 50) { footer(); newPage(); y = M + 8; tableHead(); doc.setFont('helvetica', 'normal'); doc.setTextColor(20); }
      doc.text(String(s.order), cols[0], y);
      doc.text(s.modality || '—', cols[1], y);
      doc.text(doc.splitTextToSize(s.desc, cols[3] - cols[2] - 24)[0], cols[2], y);
      doc.text(String(s.frames.length), cols[3], y, { align: 'right' });
      y += 6;
    }
    if (reports.length) {
      y += 6;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text('Referti trovati tra i file (allegati a parte):', M, y); y += 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      for (const r of reports.slice(0, 8)) { doc.text(`• ${r.name}`, M + 3, y); y += 5; }
    }
    doc.setFontSize(9); doc.setTextColor(100);
    const note = 'Nota: le immagini sono state convertite dai file DICOM originali per consentirne la visualizzazione ' +
      'su qualsiasi dispositivo. Per una valutazione diagnostica fare riferimento ai file DICOM originali.';
    doc.text(doc.splitTextToSize(note, W - 2 * M), M, H - 30);
    footer();

    // pagine delle serie
    const header = (s, extra) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(20);
      doc.text(doc.splitTextToSize(s.desc, W - 2 * M)[0], M, M + 4);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90);
      const meta = [`Serie ${s.order}`, s.modality, fmtDate(s.date), extra].filter(Boolean).join(' · ');
      doc.text(meta, M, M + 11);
      return M + 17;
    };
    const place = async (fr, x, yy, bw, bh, alias) => {
      const ratio = Math.min(bw / fr.pdf.w, bh / fr.pdf.h);
      const w = fr.pdf.w * ratio; const h = fr.pdf.h * ratio;
      const data = new Uint8Array(await fr.pdf.blob.arrayBuffer());
      doc.addImage(data, 'JPEG', x + (bw - w) / 2, yy + (bh - h) / 2, w, h, alias, 'NONE');
    };

    let alias = 0;
    for (const s of series) {
      const imgs = s.frames.filter((f) => f.pdf);
      if (!imgs.length) continue;
      if (imgs.length < GRID_FROM) {
        for (let i = 0; i < imgs.length; i++) {
          newPage();
          const top = header(s, `immagine ${i + 1} di ${imgs.length}${imgs[i].label ? ` (${imgs[i].label})` : ''}`);
          await place(imgs[i], M, top, W - 2 * M, H - top - 20, `i${alias++}`);
          footer();
          await tick();
        }
      } else {
        const per = 9;
        for (let p = 0; p < imgs.length; p += per) {
          newPage();
          const chunk = imgs.slice(p, p + per);
          const sampled = imgs.length < s.frames.length ? ` (selezione su ${s.frames.length})` : '';
          const top = header(s, `immagini ${p + 1}–${p + chunk.length} di ${imgs.length}${sampled}`);
          const gap = 3; const label = 5;
          const cw = (W - 2 * M - 2 * gap) / 3;
          const ch = (H - top - 20 - 2 * gap) / 3;
          for (let k = 0; k < chunk.length; k++) {
            const cx = M + (k % 3) * (cw + gap);
            const cy = top + Math.floor(k / 3) * (ch + gap);
            doc.setFillColor(0, 0, 0); doc.rect(cx, cy, cw, ch - label, 'F');
            await place(chunk[k], cx, cy, cw, ch - label, `i${alias++}`);
            doc.setFontSize(8); doc.setTextColor(90);
            doc.text(chunk[k].label || `img ${p + k + 1}`, cx + cw / 2, cy + ch - 1.5, { align: 'center' });
          }
          footer();
          await tick();
        }
      }
    }
    return doc.output('blob');
  }

  // ------------------------------------------------------------------ ZIP delle immagini

  async function buildZip(res) {
    const zip = new JSZip();
    for (const s of res.series) {
      const prefix = `S${pad(s.order)}`;
      const folder = zip.folder(`${prefix}_${safeName(s.desc, 'Serie')}`);
      s.frames.forEach((f, i) => folder.file(`${prefix}_${pad(i + 1, 3)}.jpg`, f.blob));
    }
    if (res.reports.length) {
      const r = zip.folder('Referti');
      res.reports.forEach((rep) => r.file(rep.name, rep.blob));
    }
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }

  // ------------------------------------------------------------------ interfaccia

  function show(which) {
    ui.start.hidden = which !== 'start';
    ui.working.hidden = which !== 'working';
    ui.result.hidden = which !== 'result';
    window.scrollTo({ top: 0 });
  }

  function setWork(title, fraction, detail) {
    ui.workTitle.textContent = title;
    ui.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    ui.workDetail.textContent = detail || ' ';
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  }

  function canShareFiles(files) {
    try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
  }

  function renderResult(res) {
    const total = res.series.reduce((a, s) => a + s.frames.length, 0);
    const m = res.series[0] ? res.series[0].meta : {};
    const summary = $('#summary');
    summary.replaceChildren();
    const add = (k, v) => { if (v) summary.append(el('dt', {}, k), el('dd', {}, v)); };
    if (ui.showName.checked) add('Paziente', m.patient);
    add('Esame', [m.studyDesc, m.institution].filter(Boolean).join(' – '));
    add('Data', fmtDate(m.studyDate));
    add('Contenuto', `${res.series.length} ${res.series.length === 1 ? 'serie' : 'serie'} · ${total} ${total === 1 ? 'immagine' : 'immagini'}`);
    if (res.reports.length) add('Referti', String(res.reports.length));

    const pdfUrl = track(URL.createObjectURL(res.pdfBlob));
    const dl = $('#downloadPdf');
    dl.href = pdfUrl;
    dl.download = res.pdfName;
    const pdfFile = new File([res.pdfBlob], res.pdfName, { type: 'application/pdf' });
    const share = $('#sharePdf');
    share.hidden = !canShareFiles([pdfFile]);
    share.onclick = async () => {
      try { await navigator.share({ files: [pdfFile], title: res.pdfName }); } catch { /* annullato */ }
    };
    dl.classList.toggle('primary', share.hidden);

    const warnings = $('#warnings');
    warnings.replaceChildren();
    if (res.errors.length) {
      const list = el('ul');
      res.errors.slice(0, 8).forEach((e) => list.append(el('li', {}, e)));
      if (res.errors.length > 8) list.append(el('li', {}, `…e altri ${res.errors.length - 8}`));
      warnings.append(el('div', { class: 'notice' }, `${res.errors.length} file non sono stati convertiti:`, list));
    }

    const repCard = $('#reportsCard');
    const repList = $('#reports');
    repList.replaceChildren();
    repCard.hidden = !res.reports.length;
    for (const r of res.reports) {
      const a = el('a', { class: 'btn', href: track(URL.createObjectURL(r.blob)), download: r.name, target: '_blank', rel: 'noopener' }, 'Apri');
      repList.append(el('li', {}, el('span', { class: 'ellipsis' }, r.name), a));
    }

    renderGallery(res);
    show('result');
  }

  let viewerList = [];
  let viewerIndex = 0;

  function renderGallery(res) {
    const gallery = $('#gallery');
    gallery.replaceChildren();
    viewerList = [];
    for (const s of res.series) {
      const section = el('div', { class: 'series' });
      section.append(el('div', { class: 'series-head' },
        el('h3', {}, `${s.order}. ${s.desc}`),
        el('span', { class: 'small muted' }, `${s.modality ? `${s.modality} · ` : ''}${s.frames.length} img`)));
      const grid = el('div', { class: 'grid' });
      section.append(grid);
      const addThumbs = (from, to) => {
        for (let i = from; i < Math.min(to, s.frames.length); i++) {
          const f = s.frames[i];
          if (!f.url) f.url = track(URL.createObjectURL(f.blob));
          const index = viewerList.length;
          viewerList.push({ url: f.url, caption: `${s.desc} · immagine ${i + 1} di ${s.frames.length}` });
          grid.append(el('button', { class: 'thumb', type: 'button', 'aria-label': `Apri immagine ${i + 1}`, onclick: () => openViewer(index) },
            el('img', { src: f.url, alt: '', loading: 'lazy', decoding: 'async' })));
        }
      };
      addThumbs(0, GALLERY_PAGE);
      if (s.frames.length > GALLERY_PAGE) {
        const more = el('button', { class: 'btn more', type: 'button' }, `Mostra tutte le ${s.frames.length} immagini`);
        more.addEventListener('click', () => { addThumbs(GALLERY_PAGE, s.frames.length); more.remove(); });
        section.append(more);
      }
      gallery.append(section);
    }
  }

  function openViewer(i) {
    viewerIndex = (i + viewerList.length) % viewerList.length;
    const item = viewerList[viewerIndex];
    $('#viewerImg').src = item.url;
    $('#viewerCaption').textContent = item.caption;
    $('#viewer').hidden = false;
  }
  function closeViewer() { $('#viewer').hidden = true; }

  function reset() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    current = null;
    ui.fileInput.value = '';
    ui.dirInput.value = '';
    show('start');
  }

  async function run(files) {
    if (!files || !files.length) return;
    try {
      await convert(files);
    } catch (e) {
      console.error(e);
      show('start');
      const memory = /memory|allocation|RangeError/i.test(String(e && (e.message || e)));
      alert(memory
        ? 'Il dispositivo ha esaurito la memoria. Prova a convertire meno file alla volta (per esempio una serie per volta).'
        : `Qualcosa è andato storto durante la conversione: ${e && e.message ? e.message : e}`);
    }
  }

  // ------------------------------------------------------------------ eventi

  ui.pick.addEventListener('click', () => ui.fileInput.click());
  ui.pickDir.addEventListener('click', () => ui.dirInput.click());
  ui.fileInput.addEventListener('change', () => run([...ui.fileInput.files]));
  ui.dirInput.addEventListener('change', () => run([...ui.dirInput.files]));

  if (window.matchMedia('(pointer: fine)').matches && 'webkitdirectory' in ui.dirInput) {
    ui.pickDir.hidden = false;
    $('#dropHint').textContent = 'Oppure trascina qui la cartella dell\'esame o un file .zip.';
  }

  ['dragenter', 'dragover'].forEach((t) => ui.drop.addEventListener(t, (e) => {
    e.preventDefault(); ui.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => ui.drop.addEventListener(t, () => ui.drop.classList.remove('over')));
  ui.drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = await filesFromDrop(e.dataTransfer);
    run(files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#downloadZip').addEventListener('click', async (e) => {
    if (!current) return;
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparo lo .zip…';
    try {
      const blob = await buildZip(current);
      const name = current.pdfName.replace(/^Immagini_esame/, 'Immagini_JPG').replace(/\.pdf$/, '.zip');
      const a = el('a', { href: track(URL.createObjectURL(blob)), download: name });
      document.body.append(a); a.click(); a.remove();
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });
  $('#again').addEventListener('click', reset);
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerPrev').addEventListener('click', () => openViewer(viewerIndex - 1));
  $('#viewerNext').addEventListener('click', () => openViewer(viewerIndex + 1));
  document.addEventListener('keydown', (e) => {
    if ($('#viewer').hidden) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') openViewer(viewerIndex - 1);
    if (e.key === 'ArrowRight') openViewer(viewerIndex + 1);
  });

  // aggancio per i test automatici (nessun effetto per l'utente)
  window.__dicomFacile = { decodeImage, convert, groupSeries, current: () => current };
})();
