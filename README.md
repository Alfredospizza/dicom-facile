# DICOM Facile

Pagina web che converte i file DICOM (`.dcm`) in un **PDF** e in **immagini JPG**, direttamente sul telefono o sul computer.

**I file non lasciano mai il dispositivo.** La conversione avviene interamente nel browser: nessun server, nessun account, nessun tracciamento. La pagina dichiara una Content Security Policy con `connect-src 'none'`, quindi il browser stesso le impedisce di inviare dati.

## Come si usa

1. Apri la pagina.
2. Tocca **Scegli i file** e seleziona i file `.dcm`, oppure uno `.zip` con tutta la cartella (su iPhone: app File → tieni premuto sulla cartella → Comprimi).
3. Scarica o invia il PDF, oppure scarica tutte le immagini in JPG.

## Cosa supporta

- File DICOM non compressi e compressi: JPEG baseline/extended/lossless, JPEG-LS, JPEG 2000, RLE, deflate
- Scala di grigi (con la finestra di visualizzazione salvata nei file), colore RGB/YBR, palette, immagini multi-frame
- Documenti PDF incapsulati nei file DICOM
- Cartelle copiate da CD (file di programmi, DICOMDIR ecc. vengono ignorati)

## Librerie

Incluse nella cartella `lib/` (nessuna risorsa esterna): [daikon](https://github.com/rii-mango/Daikon) 1.2.46, [jsPDF](https://github.com/parallax/jsPDF) 4.2.1, [JSZip](https://github.com/Stuk/jszip) 3.10.2. Licenze in [`lib/LICENSES.txt`](lib/LICENSES.txt).
