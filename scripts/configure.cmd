@echo off
uv run --no-project --python 3.12 "%~dp0configure.py" %*
exit /b %errorlevel%
