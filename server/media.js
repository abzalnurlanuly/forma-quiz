// Read only container headers; uploaded bytes are never executed or passed to a shell.
// Bound pixel dimensions as well as compressed file size to protect student browsers.
export function imageDimensions(bytes, kind) {
  if (kind === "png") {
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      return null;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (kind === "gif") {
    if (
      bytes.length < 13 ||
      !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    )
      return null;
    return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  }
  if (kind === "jpeg") {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
    let offset = 2;
    const startOfFrame = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (startOfFrame.has(marker)) {
        if (length < 8) return null;
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    return null;
  }
  if (kind === "webp") {
    if (
      bytes.length < 20 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      return null;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (data + length > bytes.length) return null;
      if (type === "VP8X" && length >= 10)
        return [
          bytes.readUIntLE(data + 4, 3) + 1,
          bytes.readUIntLE(data + 7, 3) + 1,
        ];
      if (
        type === "VP8 " &&
        length >= 10 &&
        bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 1 &&
        bytes[data + 5] === 0x2a
      )
        return [
          bytes.readUInt16LE(data + 6) & 0x3fff,
          bytes.readUInt16LE(data + 8) & 0x3fff,
        ];
      if (type === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
        const packed = bytes.readUInt32LE(data + 1);
        return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
      }
      offset = data + length + (length % 2);
    }
  }
  return null;
}
