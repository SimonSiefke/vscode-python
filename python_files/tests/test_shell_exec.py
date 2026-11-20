# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[1] / "shell_exec.py"
WAIT_FOR_INPUT = "from pathlib import Path; import sys; Path(sys.argv[1]).touch(); input()"


def terminal_command(marker: Path, code: str, *args: Path) -> list[str]:
    return [sys.executable, str(HELPER), sys.executable, "-c", code, *map(str, args), str(marker)]


def wait_for_child(ready: Path, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 5
    while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert ready.exists()


def test_missing_marker_prevents_delayed_dispatch(tmp_path: Path) -> None:
    marker = tmp_path / "status"
    child_ran = tmp_path / "child-ran"
    code = "from pathlib import Path; import sys; Path(sys.argv[1]).touch()"

    subprocess.run(terminal_command(marker, code, child_ran), check=True, timeout=5)

    assert not marker.exists()
    assert not child_ran.exists()


@pytest.mark.parametrize(
    ("code", "expected_state"),
    [("pass", "END\n"), ("raise RuntimeError('fixture failure')", "FAIL\n")],
)
def test_finished_command_updates_owned_marker(
    tmp_path: Path, code: str, expected_state: str
) -> None:
    marker = tmp_path / "status"
    marker.touch()

    subprocess.run(terminal_command(marker, code), check=True, timeout=5)

    result = marker.read_text(encoding="utf-8")
    assert result.startswith(expected_state)
    if expected_state == "FAIL\n":
        assert "returned non-zero exit status" in result
    assert not marker.with_suffix(".error").exists()


def test_marker_can_be_removed_while_child_is_running(tmp_path: Path) -> None:
    marker = tmp_path / "status"
    marker.touch()
    ready = tmp_path / "ready"

    with subprocess.Popen(
        terminal_command(marker, WAIT_FOR_INPUT, ready),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    ) as process:
        try:
            wait_for_child(ready, process)
            assert marker.read_text(encoding="utf-8") == "START\n"
            marker.unlink()
        finally:
            try:
                process.communicate(input="\n", timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
                raise

    assert process.returncode == 0
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="Use a private foreground process group for SIGINT.")
def test_ctrl_c_records_cancellation_before_helper_exits(tmp_path: Path) -> None:
    marker = tmp_path / "status"
    marker.touch()
    ready = tmp_path / "ready"

    with subprocess.Popen(
        terminal_command(marker, WAIT_FOR_INPUT, ready),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as process:
        try:
            wait_for_child(ready, process)
            assert marker.read_text(encoding="utf-8") == "START\n"
            os.killpg(process.pid, signal.SIGINT)
            process.communicate(timeout=5)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)

    assert process.returncode != 0
    assert marker.read_text(encoding="utf-8") == "CANCELED\n"
