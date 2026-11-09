#!/usr/bin/env python3
"""Bundle the universal FFmpeg decoder pack into the APK.

The FFmpeg-Kit "full-gpl" AAR ships ten shared libraries per ABI. They are
copied into the APK as UNCOMPRESSED `lib/<abi>/*.so` entries (Android extracts
them at install time), and the original AAR is stored as an on-device decoder
archive for offline repair/upgrade. Uncompressed entries are what make the
universal APK genuinely fat instead of a 40 MB compressed husk.

Usage: add-native-libs.py <base.apk> <ffmpeg.aar>
"""
import os
import sys
import zipfile


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: add-native-libs.py <base.apk> <ffmpeg.aar>", file=sys.stderr)
        return 2
    base, aar = sys.argv[1], sys.argv[2]
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
            zout.writestr(info, zin.read(info.filename))

        for info in az.infolist():
            name = info.filename
            if not name.startswith("jni/") or not name.endswith(".so"):
                continue
            parts = name.split("/")
            if len(parts) != 3:
                continue
            abi, soname = parts[1], parts[2]
            zi = zipfile.ZipInfo("lib/" + abi + "/" + soname, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            zout.writestr(zi, az.read(name))
            libs += 1

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
