@echo off
set TEXT=%~1
if "%TEXT%"=="" set TEXT=晚上好，我是 hamster

python "%~dp0say.py" "%TEXT%"
