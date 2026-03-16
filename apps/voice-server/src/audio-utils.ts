/**
 * Audio format conversion utilities.
 *
 * Twilio streams use μ-law (mulaw) encoded audio at 8 kHz.
 * Deepgram (and internal processing) prefers PCM16 (signed 16-bit little-endian).
 *
 * μ-law encoding table follows the ITU-T G.711 standard.
 */

const MULAW_BIAS = 0x84 // 132

/**
 * Decode a single μ-law encoded byte to a signed 16-bit PCM sample.
 * Algorithm: ITU-T G.711 μ-law decode.
 */
function mulawDecode(mulaw: number): number {
  // Invert all bits
  const m = ~mulaw & 0xff
  const sign = m & 0x80
  const exponent = (m >> 4) & 0x07
  const mantissa = m & 0x0f

  let sample = (mantissa << (exponent + 3)) + MULAW_BIAS * (1 << (exponent + 2))
  if (sign !== 0) {
    sample = -sample
  }

  // Clamp to int16 range
  return Math.max(-32768, Math.min(32767, sample))
}

/**
 * Encode a signed 16-bit PCM sample to μ-law.
 * Algorithm: ITU-T G.711 μ-law encode.
 */
function mulawEncode(sample: number): number {
  // Clamp
  const clamped = Math.max(-32768, Math.min(32767, sample))
  let sign: number
  let s: number

  if (clamped < 0) {
    sign = 0x80
    s = -clamped - 1
  } else {
    sign = 0
    s = clamped
  }

  s += MULAW_BIAS

  // Find exponent
  let exponent = 7
  for (let exp = 0; exp < 8; exp++) {
    if (s < (1 << (exp + 4))) {
      exponent = exp
      break
    }
  }

  const mantissa = (s >> (exponent + 3)) & 0x0f
  const encoded = ~(sign | (exponent << 4) | mantissa) & 0xff
  return encoded
}

/**
 * Convert Twilio's μ-law 8 kHz audio to signed PCM16 little-endian.
 * Each μ-law byte expands to 2 PCM bytes (little-endian int16).
 */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const pcm = Buffer.allocUnsafe(mulaw.length * 2)
  for (let i = 0; i < mulaw.length; i++) {
    const sample = mulawDecode(mulaw[i] ?? 0)
    // Write little-endian int16
    pcm.writeInt16LE(sample, i * 2)
  }
  return pcm
}

/**
 * Convert PCM16 little-endian audio back to μ-law for Twilio.
 * Each pair of PCM bytes (int16 LE) compresses to 1 μ-law byte.
 * Input must have even length.
 */
export function pcm16ToMulaw(pcm16: Buffer): Buffer {
  if (pcm16.length % 2 !== 0) {
    throw new RangeError('PCM16 buffer must have even length')
  }
  const mulaw = Buffer.allocUnsafe(pcm16.length / 2)
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcm16.readInt16LE(i * 2)
    mulaw[i] = mulawEncode(sample)
  }
  return mulaw
}
