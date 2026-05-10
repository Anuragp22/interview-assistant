import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export class CvParseError extends Error {
  constructor(message: string, public readonly kind: "unsupported" | "extract-failed" | "empty") {
    super(message);
  }
}

/**
 * Extract plain text from a candidate's uploaded resume. We do MIME
 * sniffing (don't trust file extensions — recruiters get creative) and
 * dispatch to the right extractor.
 *
 * unpdf is the serverless-safe choice for PDFs (pdf-parse pulls canvas,
 * which breaks on Vercel/Lambda). mammoth handles DOCX with no native
 * deps. Both run in the Node runtime — server actions calling this
 * MUST set `export const runtime = "nodejs"`.
 *
 * Throws CvParseError("empty") when extraction succeeded but the result
 * is whitespace-only (image-only PDFs land here). The caller surfaces
 * a "paste your CV manually" textarea fallback in that case.
 */
export async function extractResumeText(
  buffer: Buffer | Uint8Array,
  mimeType: string,
): Promise<string> {
  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer);

  let text: string;
  if (mimeType === "application/pdf" || isPdfMagic(bytes)) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: true });
    text = result.text;
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    isDocxMagic(bytes)
  ) {
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
  } else {
    throw new CvParseError(
      `Unsupported CV format: ${mimeType}. Use PDF or DOCX.`,
      "unsupported",
    );
  }

  const cleaned = text.trim().replace(/\s+\n/g, "\n");
  if (cleaned.length === 0) {
    throw new CvParseError(
      "Extracted CV text is empty (image-only resume?).",
      "empty",
    );
  }
  return cleaned;
}

// Magic-byte sniffing fallback when MIME isn't reliable.
function isPdfMagic(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // '%PDF'
}

function isDocxMagic(b: Buffer): boolean {
  // DOCX is a ZIP — magic 'PK\x03\x04'
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
