"""Read bounded regular-file bytes through held POSIX directory descriptors.

No component is checked and then reopened by pathname: openat + O_NOFOLLOW
reject symlinks atomically. The configured root's identity is pinned by Node.
"""
import base64
import json
import os
import stat
import sys


def read_artifact(request):
    ref = request["ref"]
    parts = [part for part in ref.split("/") if part not in ("", ".")]
    if ref.startswith("/") or not parts or any(part == ".." or "\\" in part for part in parts):
        return None
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory_flags = flags | os.O_DIRECTORY
    descriptors = []
    try:
        current = os.open("/", directory_flags)
        descriptors.append(current)
        for part in request["root"].split("/"):
            if not part:
                continue
            current = os.open(part, directory_flags, dir_fd=current)
            descriptors.append(current)
        root_stat = os.fstat(current)
        if (root_stat.st_dev, root_stat.st_ino) != (request["device"], request["inode"]):
            return None
        for part in parts[:-1]:
            current = os.open(part, directory_flags, dir_fd=current)
            descriptors.append(current)
        file = os.open(parts[-1], flags, dir_fd=current)
        descriptors.append(file)
        file_stat = os.fstat(file)
        limit = request["max_bytes"]
        if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size > limit:
            return None
        chunks, size = [], 0
        while True:
            chunk = os.read(file, min(65536, limit + 1 - size))
            if not chunk:
                return base64.b64encode(b"".join(chunks)).decode("ascii")
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


if __name__ == "__main__":
    try:
        result = read_artifact(json.load(sys.stdin))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, NotImplementedError):
        result = None
    print(json.dumps(result))
