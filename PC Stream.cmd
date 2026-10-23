@echo off
rem Запуск ПК-сервера PC Stream (двойной щелчок)
cd /d "%~dp0pc"
start "" "node_modules\electron\dist\electron.exe" .
