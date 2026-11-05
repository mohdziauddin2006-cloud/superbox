import sys
import zipfile

apk = sys.argv[1]
dex = sys.argv[2]

with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("classes.dex added to", apk)
