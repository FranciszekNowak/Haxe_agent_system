@echo off
cd /d C:\Projects\haxe-agents
echo Current status:
git status
echo.
set /p ans = "Commit any unsaved changes (y/n)?"
if /l "%ans%" == "y":
(
git add -A 
set /p msg = "Type in your commit message:"
git commit -m "%msg%""

)
echo.
echo Pushing to GitHub...
git push
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Push failed - check network connection and try again
    pause
    exit /b 1
)
echo.
echo Done. Safe to switch desktops.
pause