import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { buildQrPayload } from './codes.js';

const LETTER = { w: 612, h: 792 }; // 8.5 x 11 in points
const COLS = 2;
const ROWS = 5;
const MARGIN = 24;
const GAP = 10;

export async function generateBadgesPdf(db, { outPath, title = 'Guest Badge' } = {}) {
  const target = resolve(outPath || 'out/badges.pdf');
  mkdirSync(dirname(target), { recursive: true });

  const guests = db
    .prepare('SELECT guest_id, name, group_name, code FROM guests ORDER BY name COLLATE NOCASE')
    .all();

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.CourierBold);

  const badgeW = (LETTER.w - MARGIN * 2 - GAP * (COLS - 1)) / COLS;
  const badgeH = (LETTER.h - MARGIN * 2 - GAP * (ROWS - 1)) / ROWS;
  const perPage = COLS * ROWS;

  const qrCache = new Map();
  const qrPng = async (guestId) => {
    if (!qrCache.has(guestId)) {
      const buf = await QRCode.toBuffer(buildQrPayload(guestId), {
        type: 'png',
        errorCorrectionLevel: 'Q',
        margin: 1,
        width: 320,
      });
      qrCache.set(guestId, buf);
    }
    return pdf.embedPng(qrCache.get(guestId));
  };

  let page;
  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i];
    const pos = i % perPage;
    if (pos === 0) page = pdf.addPage([LETTER.w, LETTER.h]);
    const col = pos % COLS;
    const row = Math.floor(pos / COLS);

    const x = MARGIN + col * (badgeW + GAP);
    const yTop = LETTER.h - MARGIN - row * (badgeH + GAP);
    const y = yTop - badgeH;

    page.drawRectangle({
      x,
      y,
      width: badgeW,
      height: badgeH,
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 1,
    });

    const img = await qrPng(guest.guest_id);
    const qrSize = badgeH - 20;
    page.drawImage(img, { x: x + 10, y: y + 10, width: qrSize, height: qrSize });

    const textX = x + 10 + qrSize + 12;
    const maxTextW = badgeW - (textX - x) - 10;
    let nameSize = 15;
    while (nameSize > 8 && bold.widthOfTextAtSize(guest.name, nameSize) > maxTextW) nameSize--;
    page.drawText(guest.name, {
      x: textX,
      y: yTop - 26,
      size: nameSize,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    if (guest.group_name) {
      page.drawText(guest.group_name, {
        x: textX,
        y: yTop - 42,
        size: 9,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });
    }
    page.drawText('FALLBACK CODE', {
      x: textX,
      y: y + 46,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText(guest.code, {
      x: textX,
      y: y + 30,
      size: 18,
      font: mono,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(title, {
      x: textX,
      y: y + 12,
      size: 7,
      font,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  const bytes = await pdf.save();
  await new Promise((res, rej) => {
    const ws = createWriteStream(target);
    ws.on('finish', res);
    ws.on('error', rej);
    ws.end(Buffer.from(bytes));
  });

  return { path: target, guests: guests.length, pages: pdf.getPageCount() };
}
