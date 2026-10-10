"""Extract one member of a zip archive as a sparse file.

Usage: python3 -I unzip_sparse.py <archive.zip> <member-name> <output-path>

Disk images are mostly empty space; all-zero 64 KB blocks are skipped with a
seek so the output occupies only the space its real content needs.
"""
import sys, zipfile

BLOCK = 65536

def main():
    archive, member, out_path = sys.argv[1:4]
    zero = bytes(BLOCK)
    with zipfile.ZipFile(archive) as z, z.open(member) as src, open(out_path, "wb") as dst:
        size = 0
        while True:
            block = src.read(BLOCK)
            if not block:
                break
            if block == zero[:len(block)]:
                dst.seek(len(block), 1)
            else:
                dst.write(block)
            size += len(block)
        dst.truncate(size)
    print(f"{out_path}: {size} bytes")

if __name__ == "__main__":
    main()
