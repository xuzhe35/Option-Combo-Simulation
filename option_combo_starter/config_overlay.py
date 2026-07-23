#!/usr/bin/env python3
"""Overlay starter-owned settings onto an upstream config.ini."""

from __future__ import annotations

import argparse
import configparser
import os
import stat
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path


OVERLAY_KEYS = (
    ("tws", "host", "TWS_HOST"),
    ("tws", "port", "TWS_PORT"),
    ("tws", "client_id", "TWS_CLIENT_ID"),
    ("server", "ws_host", "WS_HOST"),
    ("server", "ws_port", "WS_PORT"),
    ("yield_curve", "data_dir", "YIELD_CURVE_DATA_DIR"),
)


class ConfigOverlayError(RuntimeError):
    """Raised when an input cannot produce a safe runtime configuration."""


def _read_config(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(
        interpolation=None,
        empty_lines_in_values=False,
    )
    # Keep the spelling of every upstream key. Runtime ConfigParser lookups are
    # case-insensitive, so overlay matching below is case-insensitive as well.
    parser.optionxform = str
    try:
        with path.open("r", encoding="utf-8-sig") as config_file:
            parser.read_file(config_file)
    except (OSError, configparser.Error) as exc:
        raise ConfigOverlayError(f"cannot read INI file {path}: {exc}") from exc
    return parser


def _matching_option(
    parser: configparser.ConfigParser,
    section: str,
    option: str,
) -> str | None:
    if not parser.has_section(section):
        return None
    matches = [
        existing
        for existing in parser[section]
        if existing.casefold() == option.casefold()
    ]
    if len(matches) > 1:
        raise ConfigOverlayError(
            f"ambiguous duplicate option [{section}] {option}"
        )
    return matches[0] if matches else None


def _get_required_default(
    defaults: configparser.ConfigParser,
    section: str,
    option: str,
) -> str:
    matched_option = _matching_option(defaults, section, option)
    if matched_option is None:
        raise ConfigOverlayError(
            f"bundled defaults are missing [{section}] {option}"
        )
    value = defaults.get(section, matched_option, raw=True)
    if not value:
        raise ConfigOverlayError(
            f"bundled default [{section}] {option} must not be empty"
        )
    return value


def _validate_value(section: str, option: str, value: str) -> None:
    if "\n" in value or "\r" in value:
        raise ConfigOverlayError(
            f"override [{section}] {option} must be a single-line value"
        )


def overlay_config(
    target_path: str | os.PathLike[str],
    defaults_path: str | os.PathLike[str],
    environ: Mapping[str, str] | None = None,
) -> None:
    """Atomically merge the six starter-owned keys into ``target_path``."""

    target = Path(target_path)
    defaults_file = Path(defaults_path)
    runtime = _read_config(target)
    defaults = _read_config(defaults_file)
    environment = os.environ if environ is None else environ

    selected_values: list[tuple[str, str, str]] = []
    for section, option, environment_name in OVERLAY_KEYS:
        environment_value = environment.get(environment_name)
        value = (
            environment_value
            if environment_value is not None and environment_value != ""
            else _get_required_default(defaults, section, option)
        )
        _validate_value(section, option, value)
        selected_values.append((section, option, value))

    for section, option, value in selected_values:
        if not runtime.has_section(section):
            runtime.add_section(section)
        matched_option = _matching_option(runtime, section, option)
        runtime.set(section, matched_option or option, value)

    try:
        target_mode = stat.S_IMODE(target.stat().st_mode)
    except OSError as exc:
        raise ConfigOverlayError(f"cannot stat target INI file {target}: {exc}") from exc

    descriptor: int | None = None
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.",
            suffix=".tmp",
            dir=target.parent,
        )
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, target_mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            descriptor = None
            runtime.write(output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, target)
        temporary_path = None
    except OSError as exc:
        raise ConfigOverlayError(
            f"cannot atomically update target INI file {target}: {exc}"
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Preserve an upstream config.ini while overlaying starter-owned "
            "TWS, WebSocket, and yield-curve settings."
        )
    )
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--defaults", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        overlay_config(args.target, args.defaults)
    except ConfigOverlayError as exc:
        raise SystemExit(f"config overlay failed: {exc}") from exc
    print(f"==> Applied starter-owned settings to {args.target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
