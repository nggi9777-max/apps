@echo off
chcp 65001 >nul
rem Сборка ГазПродувка.exe на Windows 10/11 (x64)
rem Нужно один раз: Rust (https://rustup.rs) и Visual Studio Build Tools с компонентом "Разработка классических приложений на C++".
cd /d "%~dp0desktop\src-tauri"
where cargo >nul 2>nul || (echo [!] Rust не установлен. Выполните: winget install Rustlang.Rustup  и перезапустите консоль. & pause & exit /b 1)
cargo tauri --version >nul 2>nul || cargo install tauri-cli --version "^2" --locked || (pause & exit /b 1)
cargo tauri build || (echo [!] Ошибка сборки & pause & exit /b 1)
copy /y "target\release\GazProduvka.exe" "%~dp0GazProduvka.exe" >nul
echo.
echo Готово: %~dp0GazProduvka.exe
echo Установщик: %~dp0desktop\src-tauri\target\release\bundle\nsis\
pause
