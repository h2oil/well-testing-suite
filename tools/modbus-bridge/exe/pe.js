// =============================================================================
// pe.js — tiny PE (Windows .exe) header reader / patcher for build-exe.js. No dependencies.
//
//   readPe(buf)            → { peOffset, machine, magic ('PE32' | 'PE32+'), subsystem, subsystemOffset,
//                             securityDir: { entryOffset, offset, size } }        (throws on a non-PE file)
//   setSubsystem(buf, n)   → buf patched in place (2 = WINDOWS_GUI: no console window, 3 = WINDOWS_CUI)
//   stripSignature(buf)    → a Buffer without the Authenticode certificate table (what `signtool remove /s`
//                             does): the security data directory entry is zeroed and the table, which sits
//                             at the end of the file, cut off. Done before postject changes the file, whose
//                             signature would otherwise be left behind invalid.
// Microsoft PE/COFF specification: e_lfanew at 0x3C, "PE\0\0", COFF header (20 bytes), optional header
// (magic 0x10b PE32 / 0x20b PE32+; Subsystem at +68; data directories at +96 / +112, the certificate
// table is directory 4, its "address" a file offset).
// =============================================================================
'use strict';

const SUBSYSTEM = { WINDOWS_GUI: 2, WINDOWS_CUI: 3 };

function readPe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) throw new Error('not a PE file (no MZ header)');
  const peOffset = buf.readUInt32LE(0x3C);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('not a PE file (no PE signature at 0x' + peOffset.toString(16) + ')');
  const machine = buf.readUInt16LE(peOffset + 4);
  const optSize = buf.readUInt16LE(peOffset + 20);
  const opt = peOffset + 24;
  if (opt + Math.max(optSize, 70) > buf.length) throw new Error('truncated optional header');
  const magicNum = buf.readUInt16LE(opt);
  if (magicNum !== 0x10b && magicNum !== 0x20b) throw new Error('unknown optional header magic 0x' + magicNum.toString(16));
  const plus = magicNum === 0x20b;
  const subsystemOffset = opt + 68;
  const dirs = opt + (plus ? 112 : 96), nDirs = buf.readUInt32LE(opt + (plus ? 108 : 92));
  let securityDir = { entryOffset: -1, offset: 0, size: 0 };
  if (nDirs > 4 && dirs + 5 * 8 <= opt + optSize) {
    const e = dirs + 4 * 8;
    securityDir = { entryOffset: e, offset: buf.readUInt32LE(e), size: buf.readUInt32LE(e + 4) };
  }
  return { peOffset, machine, magic: plus ? 'PE32+' : 'PE32', subsystem: buf.readUInt16LE(subsystemOffset), subsystemOffset, securityDir };
}
function setSubsystem(buf, n) {
  const pe = readPe(buf);
  buf.writeUInt16LE(n, pe.subsystemOffset);
  return buf;
}
function stripSignature(buf) {
  const pe = readPe(buf), d = pe.securityDir;
  if (d.entryOffset < 0 || !d.size) return buf;
  if (d.offset + d.size > buf.length) throw new Error('certificate table outside the file');
  const out = Buffer.from(buf);
  out.writeUInt32LE(0, d.entryOffset); out.writeUInt32LE(0, d.entryOffset + 4);
  // the table is normally the last thing in the file (8-byte aligned); cut it off when it is
  return d.offset + d.size >= buf.length - 8 ? out.subarray(0, d.offset) : out;
}

module.exports = { SUBSYSTEM, readPe, setSubsystem, stripSignature };
