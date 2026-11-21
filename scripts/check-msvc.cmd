@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
where cl
where link
echo WindowsSdkDir=%WindowsSdkDir%
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -all -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json