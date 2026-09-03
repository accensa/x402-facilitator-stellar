#!/usr/bin/env bash
# Builds test/fixtures/smart_account.wasm from the Rust source in this
# directory and copies it to test/fixtures/ where the conformance scripts
# pick it up. Idempotent; safe to re-run.
#
# Prerequisites (documented in README.md):
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   rustup target add wasm32v1-none
#
# wasm32v1-none (not wasm32-unknown-unknown): soroban-sdk >= 27 refuses the
# older target on Rust 1.82+, whose default features (reference-types,
# multi-value) are unsupported by the Soroban environment.
#
# Usage:
#   sh ./build.sh          (from anywhere; the script cds to its own dir)
set -euo pipefail
cd "$(dirname "$0")"

rustup target add wasm32v1-none >/dev/null 2>&1
cargo build --release --target wasm32v1-none
cp "target/wasm32v1-none/release/smart_account.wasm" ../smart_account.wasm

echo "built test/fixtures/smart_account.wasm ($(wc -c < ../smart_account.wasm) bytes)"