@echo off
setlocal
set /p GOOP_BACKEND_URL=Enter the publicly accessible HTTPS backend URL (no trailing slash): 
if "%GOOP_BACKEND_URL%"=="" (echo Backend URL required & pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UPLOAD-TO-S3.ps1"
if errorlevel 1 (echo Upload failed. Check AWS CLI access. & pause & exit /b 1)
echo Uploaded frontend. Check the S3 site and backend /api/status.
pause
