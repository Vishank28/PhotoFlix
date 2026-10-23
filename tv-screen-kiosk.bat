@echo off
rem PhotoFlix TV screen on a monitor connected to a Windows PC (or this PC): opens the TV page full screen in
rem Microsoft Edge with sound allowed, so token announcements play without anyone pressing a key - also after a
rem power cut. Close it with Alt+F4.
rem
rem   tv-screen-kiosk.bat                               the TV page of the PhotoFlix server on this PC
rem   tv-screen-kiosk.bat http://192.168.0.164:3200/tv/  the TV page of a PhotoFlix server on another PC
rem
rem To open it by itself at power-on: press Win+R, type shell:startup, Enter, and put a shortcut to this file there.

set "URL=http://localhost:3200/tv/"
if not "%~1"=="" set "URL=%~1"

rem A separate Edge profile, so these settings apply even when Edge is already open for something else.
start "" msedge --kiosk "%URL%" --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --no-first-run --disable-features=Translate --user-data-dir="%LOCALAPPDATA%\PhotoFlixScreen"
