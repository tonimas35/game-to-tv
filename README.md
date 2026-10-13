# game-to-tv · Juegos del Salón

**Juegos de grupo para el salón: la tele es la pantalla y los móviles son los
mandos.** Se escanea un QR y a jugar: no hay que instalar nada en los móviles.
Un pequeño servidor de Node.js corre en un PC de casa y unos *drivers* se
encargan de poner los juegos en la tele (instalar una app, abrirla, mandar
avisos, hacer capturas…).

<!-- Capturas: añadir aquí imágenes de docs/img/ (menú, Dibuja y adivina, Pong) -->
> 📸 *Capturas pendientes: menú de la tele, «Dibuja y adivina» y Pong.*

```
  Móvil 1 ──┐                          ┌── Tele (app lanzadora o navegador)
            ├── Wi‑Fi ── PC con Node ──┤   http://IP-DEL-PC:3000/
  Móvil 2 ──┘   (game-to-tv start)     └── QR → http://IP-DEL-PC:3000/m
```

## Juegos incluidos

| Juego | Jugadores | De qué va |
|---|---|---|
| **Dibuja y adivina** | 2 | Pictionary en equipo: uno dibuja en el móvil y el otro adivina mirando la tele. 8 rondas, pistas, palabras secretas para tu pareja y galería de dibujos en PNG. |
| **Pong** | 2 | El clásico, con el móvil como pala. A 60 FPS en la tele. |
| **Reflejos** | 2 a 4 | El juego de ejemplo: la tele dice «¡YA!» y gana el punto quien antes toque su móvil. Al mejor de 5. |

## Pantallas compatibles

| Pantalla | Estado | Cómo |
|---|---|---|
| LG webOS (probado en webOS 22) | ✅ | App lanzadora instalada con el modo desarrollador; emparejar, abrir, avisos, botones, capturas y medir FPS desde el PC. |
| Navegador (cualquier tele, proyector o portátil con navegador) | ✅ | Abrir la dirección que muestra `game-to-tv start`. Nada que instalar. |
| Amazon Fire TV | 🔜 | De momento, con el driver «Navegador» y el navegador Silk. Plan en [src/drivers/firetv/README.md](src/drivers/firetv/README.md). |
| Samsung Tizen | 🔜 | Pendiente (ver [docs/roadmap.md](docs/roadmap.md)). |
| Android TV / Google TV | 🔜 | Pendiente. |

## Inicio rápido

Necesitas un PC (Windows, macOS o Linux) con **Node.js 18 o superior** en la
misma red que la tele y los móviles.

```bash
npm install -g game-to-tv      # o, sin instalar: npx game-to-tv start
game-to-tv start
```

> Aún no está publicado en npm. Mientras tanto, desde el código:
> `git clone <este repositorio> && cd game-to-tv && npm install && npm link`
> (o `node bin/game-to-tv.js start`).

Verás algo así:

```
  ==========  JUEGOS DEL SALÓN · game-to-tv  ==========
  Servidor escuchando en el puerto 3000

  Tele (la app de la tele abre esto):  http://192.168.1.50:3000/
  Móviles (o escanea el QR):           http://192.168.1.50:3000/m
  ...
```

Abre la primera dirección en la tele y escanea el QR con los móviles. Si algo no
conecta, ejecuta **`game-to-tv doctor`**: revisa el puerto, la IP y el
cortafuegos de Windows y te dice exactamente qué hacer.

## Añadir una tele

### LG webOS

```bash
game-to-tv tv scan                      # busca teles LG en la red
game-to-tv tv add salon 192.168.1.50    # dale un nombre corto
game-to-tv tv pair salon                # acepta el aviso en la tele con el mando
game-to-tv tv install salon             # crea la app con la URL del servidor y la instala
game-to-tv start --abrir salon          # arranca el servidor y abre los juegos en la tele
```

Instalar la app necesita el **modo desarrollador** de LG (gratis, con una
cuenta de desarrollador) y `ares-cli`. Si falta algo, `tv install` te dice los
pasos exactos. Guía completa: [docs/tele-lg.md](docs/tele-lg.md).

¿Por qué una app y no el navegador de la tele? El navegador de webOS se quedaba
atascado en páginas que no cargaban a la primera. La app lanzadora espera a que
el servidor responda («No encuentro el servidor… reintentando») y entonces
abre los juegos.

### Cualquier otra pantalla con navegador

```bash
game-to-tv tv add proyector 192.168.1.60 --driver browser
game-to-tv tv open proyector            # te recuerda la dirección (y un QR)
```

## Cómo se juega

1. Cada jugador escanea el QR de la tele, escribe su nombre y pulsa «Unirse».
   Si alguien pierde la conexión, su sitio se le guarda 30 s.
2. Se elige juego con el mando de la tele (◀ ▶ y OK) o desde cualquier móvil.
3. En cualquier juego, «Menú» en el móvil (o **Atrás** en el mando) vuelve al
   menú, con confirmación.

Los dibujos de «Dibuja y adivina» se guardan en PNG en `~/.game-to-tv/galeria`
y se ven en `http://IP-DEL-PC:3000/galeria`.

**Modo ambiente**: `http://IP-DEL-PC:3000/ambiente` muestra un pase de las
fotos de `~/.game-to-tv/ambiente` con un reloj (hora de Madrid por defecto). Sin
fotos, muestra un fondo tranquilo. En LG: `game-to-tv tv open salon --ruta /ambiente`.

## Comandos

| Comando | Para qué |
|---|---|
| `game-to-tv start [--port 3000] [--host-ip IP] [--jugadores N] [--galeria DIR] [--abrir TELE]` | Arranca el servidor |
| `game-to-tv doctor` | Revisa Node, puerto, IP, cortafuegos de Windows, ares-cli y teles (no cambia nada) |
| `game-to-tv tv scan` | Busca teles (LG por SSDP) |
| `game-to-tv tv add NOMBRE IP [--driver webos\|browser]` · `tv list` · `tv remove NOMBRE` | Gestiona las teles |
| `game-to-tv tv pair NOMBRE` | Empareja (aviso en la tele) |
| `game-to-tv tv install NOMBRE [--server-url URL] [--solo-ipk]` · `tv ipk` | Crea e instala la app lanzadora |
| `game-to-tv tv open NOMBRE [--ruta /ambiente]` | Abre los juegos en la tele |
| `game-to-tv tv shot NOMBRE [archivo.jpg]` | Captura de pantalla de la tele |
| `game-to-tv tv perf NOMBRE` | FPS reales medidos en la tele |
| `game-to-tv tv toast NOMBRE "mensaje"` · `tv key NOMBRE ENTER` · `tv info NOMBRE` | Avisos, botones del mando, información |

La configuración (teles, clave de emparejamiento…) se guarda en
`~/.game-to-tv/config.json`. **No la compartas**: contiene la clave que permite
controlar tu tele. Variables de entorno útiles: `PORT`, `HOST_IP`,
`GAME_TO_TV_HOME`, `GALERIA_DIR`, `AMBIENTE_DIR`, `TZ_AMBIENTE`, `SLOT_HOLD_MS`.

## Añadir un juego

Cada juego es una carpeta en `src/games/<id>/` con un `manifest.json`, la
lógica del servidor (`index.js`) y las vistas de la tele (`tv.js`) y del móvil
(`phone.js`). El menú, la conexión, los jugadores y la reconexión ya los pone
el hub. Guía paso a paso con un juego completo de ejemplo («Reflejos»):
**[docs/crear-un-juego.md](docs/crear-un-juego.md)**.

## Más documentación

- [docs/arquitectura.md](docs/arquitectura.md): cómo encaja todo.
- [docs/crear-un-juego.md](docs/crear-un-juego.md): tu propio juego en una tarde.
- [docs/drivers.md](docs/drivers.md): cómo dar soporte a otra marca de tele.
- [docs/tele-lg.md](docs/tele-lg.md): guía completa para LG (modo desarrollador incluido).
- [docs/solucion-problemas.md](docs/solucion-problemas.md): cortafuegos, IP, FPS, salvapantallas, YouTube, iconos…
- [docs/roadmap.md](docs/roadmap.md): lo que viene.
- [CONTRIBUTING.md](CONTRIBUTING.md): cómo colaborar.

## Desarrollo

```bash
npm install
npm test               # servidor, juegos y drivers (tele LG falsa); sin red ni tele real
npm run check          # el JavaScript del navegador debe ser ES2019 (Chromium 87 de webOS 22)
npm run test:browser   # prueba con Chromium sin pantalla (si Playwright está instalado)
```

## English summary

**game-to-tv** turns the living-room TV into a party-game screen while
everyone's phone becomes the controller (scan a QR code, no app install). A
small Node.js server (HTTP + WebSocket on one port) runs on a PC on the home
LAN. Games are self-contained folders (`src/games/<id>/`: manifest, server
module, TV view, phone view); the hub handles players, reconnection, the menu
and the QR. *Drivers* get the game screen onto TVs: the LG webOS driver
discovers TVs (SSDP), pairs over SSAP, builds and installs a tiny launcher app
(pure-JS `.ipk` packaging, installed with LG's `ares-cli` in Developer Mode),
launches it, sends toasts and remote buttons, takes screenshots and measures
real FPS through Chrome DevTools. A generic «browser» driver covers any screen
with a web browser; Fire TV, Tizen and Android TV are on the roadmap.
Includes «Dibuja y adivina» (Pictionary for two), Pong and a tiny example
game. UI and docs are in Spanish. Quick start: `npx game-to-tv start`, then
`game-to-tv doctor` if anything fails to connect.

## Licencia

[MIT](LICENSE).
