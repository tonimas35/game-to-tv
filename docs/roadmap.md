# Hoja de ruta

Ideas ordenadas más o menos por prioridad. ¿Te apetece alguna? Mira
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Pantallas

- ~~Fire TV, Android TV y Google TV~~: hecho, con el servidor dentro de la
  tele ([tele-android.md](tele-android.md)). Pendiente: publicar los APK en
  las «releases» para descargarlos sin iniciar sesión en GitHub, y buscar las
  teles Android en la red (`tv scan`).
- **Samsung Tizen**: app web empaquetada (`.wgt`) con Tizen Studio / `tizen`
  CLI en modo desarrollador; control remoto por el WebSocket de Samsung
  (puerto 8002) con su emparejamiento por aviso.
- **Chromecast**: «Cast» de una página web (receptor personalizado).
- `tv scan` para más marcas (DIAL/SSDP genérico, mDNS).

## Juegos

- Trivial por equipos (preguntas en el móvil, marcador en la tele).
- «¿Quién es más probable que…?» (votaciones).
- **Dibuja y adivina por equipos** (2 contra 2 o 3 contra 3): en 0.3 hay
  «todos contra todos» de 3 a 6. Por equipos haría falta repartir los equipos
  (en el menú o al azar), que solo adivine el equipo del que dibuja (o robo de
  puntos del otro), marcador de equipo y una tele que distinga los equipos sin
  desvelar nada al rival. No encajaba limpio en el mismo juego sin complicar el
  todos contra todos: queda pendiente.
- Dibuja y adivina: elegir 1 o 2 vueltas desde el menú de la tele (ahora: 2
  con 3-4 jugadores y 1 con 5-6; `DIBUJA_VUELTAS` lo fuerza).
- Pong: elegir los equipos (ahora: jugadores 1 y 3 contra 2 y 4) y rotar quién
  juega solo con 3.
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
