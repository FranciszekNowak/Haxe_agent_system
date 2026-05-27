@echo off
cd /d C:\Projects\haxe-agents
echo Pulling latest changes from GitHub...
git pull --rebase
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ============================================
    echo Pull failed - resolve conflicts before continuing
    echo Run: git status
    echo Run: git diff
    echo ============================================
    pause
    exit /b 1
)
echo.
echo Ready to work
echo.
echo Recent commits:
git log --oneline -5
echo.
pause