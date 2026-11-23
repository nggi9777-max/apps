#!/bin/bash
# Сборка ГазПродувки для macOS (Apple Silicon M1–M5 и Intel) → установщик .dmg
set -e
cd "$(dirname "$0")/desktop/src-tauri"
xcode-select -p >/dev/null 2>&1 || { echo "Установите инструменты Apple: xcode-select --install  (затем запустите скрипт снова)"; exit 1; }
command -v cargo >/dev/null || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; source "$HOME/.cargo/env"; }
cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version "^2" --locked
cargo tauri build --bundles dmg
DMG=$(ls target/release/bundle/dmg/*.dmg | head -1)
cp "$DMG" "$(dirname "$0")/../../" 2>/dev/null || true
echo; echo "Готово: $DMG"; open target/release/bundle/dmg/
