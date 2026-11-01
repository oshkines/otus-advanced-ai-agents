@echo off
rem ======================================================================
rem  [AUTO HOOK] Pre-commit-валидация проекта AI Dev Orchestrator
rem
rem  Запуск вручную:          pre-commit.bat
rem  Другой файл конфигурации: pre-commit.bat config\other.json
rem  Как git-хук:             скопировать содержимое в .git\hooks\pre-commit
rem
rem  Коды выхода: 0 - проверки пройдены (коммит разрешён)
rem               1 - найдены ошибки (коммит блокируется)
rem ======================================================================
chcp 65001 >nul
setlocal EnableExtensions

rem Работаем из каталога скрипта: относительные пути не зависят от текущего
rem каталога вызова (важно при запуске по полному пути и из git-хука).
cd /d "%~dp0"

set "CONFIG=%~1"
if "%CONFIG%"=="" set "CONFIG=config\orchestrator.json"
set "FAILED=0"

echo === [AUTO HOOK] Запуск проверки перед фиксацией кода ===
echo.

rem --- Проверка 1: файл конфигурации существует -------------------------
echo [1/3] Проверка наличия файла "%CONFIG%" ...
if not exist "%CONFIG%" (
    echo [ОШИБКА] Файл конфигурации не найден: %CONFIG%
    set "FAILED=1"
    goto :report
)
echo [УСПЕХ] Файл найден.

rem --- Проверка 2: кодировка файла конфигурации -------------------------
rem В конфиге не должно быть кириллицы: C++ (MSVC) и Python читают файл в
rem разных кодовых страницах - риск mojibake. BOM допускается.
rem findstr работает побайтово и в cp65001 ловит байты BOM как кириллицу
rem (ложное срабатывание), поэтому основная проверка - через Python.
echo.
echo [2/3] Проверка кодировки файлов конфигурации...
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import sys,re; s=open(sys.argv[1],'rb').read().decode('utf-8-sig'); sys.exit(1 if re.search('[\u0400-\u04FF]', s) else 0)" "%CONFIG%" >nul 2>&1
    if errorlevel 1 (
        echo [ОШИБКА] В конфиге найдена кириллица или файл не в UTF-8.
        set "FAILED=1"
    ) else (
        echo [УСПЕХ] Конфигурация валидна.
    )
) else (
    echo [ПРЕДУПРЕЖДЕНИЕ] Python не найден - резервная проверка findstr.
    findstr /R /C:"[а-яА-Я]" "%CONFIG%" >nul
    if errorlevel 1 (
        echo [УСПЕХ] Конфигурация валидна.
    ) else (
        echo [ОШИБКА] В конфиге найдена кириллица - возможна ошибка кодировки.
        set "FAILED=1"
    )
)

rem --- Проверка 3: валидность JSON и читаемость как UTF-8 --------------
rem utf-8-sig допускает необязательный BOM - MSVC часто пишет файлы с BOM,
rem при этом не-UTF-8 кодировка всё равно будет отвергнута.
echo.
echo [3/3] Проверка JSON-структуры...
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8-sig'))" "%CONFIG%" >nul 2>&1
    if errorlevel 1 (
        echo [ОШИБКА] Невалидный JSON или файл не читается как UTF-8.
        set "FAILED=1"
    ) else (
        echo [УСПЕХ] JSON-структура валидна - UTF-8, BOM допускается.
    )
) else (
    echo [ПРЕДУПРЕЖДЕНИЕ] .venv\Scripts\python.exe не найден - проверка JSON пропущена.
)

:report
echo.
if "%FAILED%"=="1" (
    echo === [AUTO HOOK] ПРОВЕРКА НЕ ПРОЙДЕНА: коммит заблокирован ===
    exit /b 1
)
echo === [AUTO HOOK] ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ: можно фиксировать код ===
exit /b 0
