@echo off
if not exist "%~dp0..\backend\.venv\Scripts\python.exe" (
  echo Backend environment missing. Run scripts\setup.cmd first. 1>&2
  exit /b 1
)
"%~dp0..\backend\.venv\Scripts\python.exe" "%~dp0manage.py" start %*
exit /b %errorlevel%
