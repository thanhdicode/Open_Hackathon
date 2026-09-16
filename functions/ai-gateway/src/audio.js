/**
 * Audio container helpers.
 *
 * Gemini 3.1 Flash TTS returns headerless 16-bit PCM (`audio/L16;codec=pcm`).
 * Browsers cannot play a raw PCM response through an <audio> element, so the
 * gateway wraps it in a RIFF/WAVE container before it reaches the client.
 */

const RIFF_HEADER_BYTES = 44;

/** Parse `audio/L16;codec=pcm;rate=24000` into its sample rate. */
export function sampleRateFromMimeType(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/i.exec(mimeType ?? "");
  return match ? Number(match[1]) : fallback;
}

export function isRawPcmMimeType(mimeType) {
  return typeof mimeType === "string" && /^audio\/L\d+/i.test(mimeType);
}

export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(RIFF_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + buffer.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(buffer.length, 40);

  return Buffer.concat([header, buffer]);
}

/** Normalise provider audio into something a browser can play. */
export function toPlayableAudio(base64, mimeType) {
  if (!isRawPcmMimeType(mimeType)) return { base64, mimeType };
  const wav = pcmToWav(Buffer.from(base64, "base64"), { sampleRate: sampleRateFromMimeType(mimeType) });
  return { base64: wav.toString("base64"), mimeType: "audio/wav" };
}
