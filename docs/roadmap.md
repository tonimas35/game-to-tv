# Hoja de ruta

Ideas ordenadas más o menos por prioridad. ¿Te apetece alguna? Mira
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Pantallas

- **Fire TV** (driver `firetv`): `adb` por la red, una APK mínima con un
  `WebView`, `adb screencap` y `adb shell input keyevent`. Plan detallado en
  [src/drivers/firetv/README.md](../src/drivers/firetv/README.md).
- **Android TV / Google TV**: casi lo mismo que Fire TV (misma APK).
- **Samsung Tizen**: app web empaquetada (`.wgt`) con Tizen Studio / `tizen`
  CLI en modo desarrollador; control remoto por el WebSocket de Samsung
  (puerto 8002) con su emparejamiento por aviso.
- **Chromecast**: «Cast» de una página web (receptor personalizado).
- `tv scan` para más marcas (DIAL/SSDP genérico, mDNS).

## Juegos

- Trivial por equipos (preguntas en el móvil, marcador en la tele).
- «¿Quién es más probable que…?» (votaciones).
- Juegos para más de 2 jugadores aprovechando `--jugadores N`.
- Palabras propias de «Dibuja y adivina» desde un archivo
  (`~/.game-to-tv/palabras.txt`), además de las «palabras secretas» del menú.
- Juegos externos: cargar juegos de una carpeta del usuario
  (`~/.game-to-tv/juegos/`) sin tocar el código.

## Servidor y herramientas

- Publicar en npm (`npx game-to-tv start`).
- `doctor` para Linux (ufw/firewalld) y macOS.
- Arranque automático del servidor con el PC (servicio de Windows / systemd).
- Despertar la tele (Wake-on-LAN) si está en reposo antes de `tv open`.
- Modo tele: subir fotos del modo ambiente a la tele desde el PC.
- Prueba con navegador real en la integración continua (Playwright).
- Traducciones (la interfaz está en español de España).

## Limitaciones conocidas

- LG no permite que una app se abra sola al encender la tele.
- En LG, las apps del modo desarrollador (y con ellas el servidor del modo
  tele) desaparecen si la sesión de Developer Mode caduca.
- El modo desarrollador de LG caduca (50 h, ampliable a 999 h).
- YouTube incrustado falla con el error 153 dentro de apps `file://` de webOS.
