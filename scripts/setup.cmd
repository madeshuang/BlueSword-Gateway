@echo off
uv run --no-project --python 3.12 "%~dp0manage.py" setup %*
exit /b %errorlevel%
