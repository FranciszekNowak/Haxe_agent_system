@echo off
setlocal enabledelayedexpansion
cd /d C:\Projects\haxe-agents

echo Current status:
git status
echo.

set /p ans="Commit any unsaved changes (y/n)? "

if /i "!ans!"=="y" (
    git add -A
    set /p msg="Type in your commit message: "
    git commit -m "!msg!"
    if !ERRORLEVEL! NEQ 0 (
        echo.
        echo Commit failed.
        pause
        exit /b 1
    )
)

echo.
echo Pushing to GitHub...
git push
if !ERRORLEVEL! NEQ 0 (
    echo.
    echo Push failed - check network connection and try again
    pause
    exit /b 1
)

echo.
echo Done. Safe to switch desktops.
pause