#!/usr/bin/env python3
"""Bundle the universal FFmpeg decoder pack and the embedded VPN core.

The FFmpeg-Kit "full-gpl" AAR ships ten shared libraries per ABI. They are
copied into the APK as UNCOMPRESSED `lib/<abi>/*.so` entries (Android extracts
them at install time), and the original AAR is stored as an on-device decoder
archive for offline repair/upgrade. Uncompressed entries are what make the
universal APK genuinely fat instead of a 40 MB compressed husk.

An optional third argument points at `libs/vpn`, whose `<abi>/libusque.so`
files are injected the same way. usque is the open-source WARP/MASQUE client
that powers SuperBox Shield; it must live in the native library directory so
Android allows the app to execute it.

Usage: add-native-libs.py <base.apk> <ffmpeg.aar> [vpn-libs-dir]
"""
import os
import struct
import sys
import zipfile
import zlib


def read_entry(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    """Read an entry, tolerating aapt2's Windows backslash local headers.

    aapt2 writes nested asset paths with `\\` in the local file header while
    the central directory uses `/`, which Python 3.13 rejects as a mismatch.
    The central directory is authoritative, so fall back to the raw deflate
    stream at the recorded offset.
    """
    try:
        return zf.read(info)
    except (zipfile.BadZipFile, KeyError):
        pass
    with open(zf.filename, "rb") as fh:
        fh.seek(info.header_offset)
        header = fh.read(30)
        if len(header) != 30:
            raise zipfile.BadZipFile("truncated local header")
        fields = struct.unpack("<IHHHHHIIIHH", header)
        if fields[0] != 0x04034B50:
            raise zipfile.BadZipFile("bad local header signature")
        name_len, extra_len = fields[9], fields[10]
        fh.seek(name_len + extra_len, 1)
        data = fh.read(info.compress_size)
        if info.compress_type == zipfile.ZIP_STORED:
            return data
        if info.compress_type == zipfile.ZIP_DEFLATED:
            return zlib.decompress(data, -15)
        raise zipfile.BadZipFile(
            "unsupported compression type %d" % info.compress_type)


def add_so(zout: zipfile.ZipFile, abi: str, soname: str, data: bytes, date_time) -> None:
    zi = zipfile.ZipInfo("lib/" + abi + "/" + soname, date_time=date_time)
    zi.compress_type = zipfile.ZIP_STORED
    # 0755: Android extracts native libs with the executable bit set.
    zi.external_attr = 0o755 << 16
    zout.writestr(zi, data)


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: add-native-libs.py <base.apk> <ffmpeg.aar> [vpn-libs-dir]",
              file=sys.stderr)
        return 2
    base, aar = sys.argv[1], sys.argv[2]
    vpn_dir = sys.argv[3] if len(sys.argv) == 4 else ""
    if not os.path.isfile(base):
        print("missing APK: " + base, file=sys.stderr)
        return 2
    if not os.path.isfile(aar):
        print("missing AAR: " + aar, file=sys.stderr)
        return 2

    tmp = base + ".native"
    libs = 0
    with zipfile.ZipFile(aar) as az, \
            zipfile.ZipFile(base) as zin, \
            zipfile.ZipFile(tmp, "w") as zout:
        # Preserve every existing entry (resources, assets, classes.dex).
        for info in zin.infolist():
            zout.writestr(info, read_entry(zin, info))

        for info in az.infolist():
            name = info.filename
            if not name.startswith("jni/") or not name.endswith(".so"):
                continue
            parts = name.split("/")
            if len(parts) != 3:
                continue
            abi, soname = parts[1], parts[2]
            add_so(zout, abi, soname, az.read(name), info.date_time)
            libs += 1

        if vpn_dir and os.path.isdir(vpn_dir):
            for abi in sorted(os.listdir(vpn_dir)):
                soname = os.path.join(vpn_dir, abi, "libusque.so")
                if not os.path.isfile(soname):
                    continue
                with open(soname, "rb") as fh:
                    add_so(zout, abi, "libusque.so", fh.read(), (2024, 1, 1, 0, 0, 0))
                libs += 1
                print("bundled Shield core for " + abi)

        # Keep the complete decoder package on device as a fallback asset.
        archive_name = "assets/ffmpeg/" + os.path.basename(aar)
        zi = zipfile.ZipInfo(archive_name, date_time=(2024, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_STORED
        zi.external_attr = 0o644 << 16
        with open(aar, "rb") as fh:
            zout.writestr(zi, fh.read())

    os.replace(tmp, base)
    total = os.path.getsize(base)
    print("added %d native libraries + decoder archive (%.1f MB total)"
          % (libs, total / (1024.0 * 1024.0)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
