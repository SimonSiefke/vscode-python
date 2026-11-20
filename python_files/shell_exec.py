# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import subprocess
import sys
import traceback
from pathlib import Path

# This is a simple solution to waiting for completion of commands sent to terminal.
# 1. Intercept commands send to a terminal
# 2. Send commands to our script file with an additional argument
# 3. In here create a file that'll log the progress.
# 4. Calling code monitors the contents of the file to determine state of execution.


def write_status(lock_file: Path, state: str, details: str = "") -> bool:
    """Update an owned marker file, returning False if cancellation removed it."""
    try:
        with lock_file.open("r+", encoding="utf-8", newline="\n") as fp:
            fp.write(f"{state}\n{details}")
            fp.truncate()
    except FileNotFoundError:
        return False
    return True


def main() -> None:
    """Run the terminal command and report its state to the waiting extension."""
    lock_file = Path(sys.argv[-1])
    shell_args = sys.argv[1:-1]
    try:
        if not write_status(lock_file, "START"):
            return
        print("Executing command in shell >> " + " ".join(shell_args))
        subprocess.check_call(shell_args, stdout=sys.stdout, stderr=sys.stderr)
        write_status(lock_file, "END")
    except KeyboardInterrupt:
        write_status(lock_file, "CANCELED")
        raise
    except Exception:
        details = traceback.format_exc()
        print(details)
        write_status(lock_file, "FAIL", details)


if __name__ == "__main__":
    main()
