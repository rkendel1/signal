#!/bin/sh
# Rebuild the Ghostpost codec WASM from source. Requires:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.106 --locked
set -eu
cd "$(dirname "$0")/../codecs/ghostpost-unicode"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/ghostpost_unicode_codec.wasm
