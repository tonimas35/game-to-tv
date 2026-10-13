# game-to-tv · Juegos del Salón

**Juegos de grupo para el salón (de 2 a 6 jugadores): la tele es la pantalla y
los móviles son los mandos.** Se escanea un QR y a jugar: no hay que instalar nada en los móviles.
Un pequeño servidor de Node.js reparte el juego. En una **tele LG va dentro de
la propia tele** (el PC solo hace falta para instalar la app); con cualquier
otra pantalla, corre en un PC de casa. Unos *drivers* se encargan de poner los
juegos en la tele (instalar una app, abrirla, mandar avisos, hacer capturas…).

![Menú de Juegos del Salón en la tele](docs/img/menu.jpg)

<p>
  <img src="docs/img/dibuja-tele.jpg" alt="Dibuja y adivina en la tele" width="66%">
  <img src="docs/img/dibuja-movil.jpg" alt="El móvil de quien dibuja" width="22%">
</p>

![Pong en la tele](docs/img/pong.jpg)

```
  LG webOS (modo tele, sin PC):
  Móvil 1 ──┐            ┌──────────── Tele LG ────────────┐
     …      ├── Wi‑Fi ──▶│ app «Juegos del Salón»          │
  Móvil 6 ──┘            │ + servidor dentro (puerto 8090) │
                         └─────────────────────────────────┘
  QR en la tele → http://IP-DE-LA-TELE:8090/m

  Cualquier pantalla con navegador (modo pc):
  Móvil 1 ──┐                          ┌── Tele (navegador o app lanzadora)
     …      ├── Wi‑Fi ── PC con Node ──┤   http://IP-DEL-PC:3000/
  Móvil 6 ──┘   (game-to-tv start)     └── QR → http://IP-DEL-PC:3000/m
```

## Juegos incluidos

| Juego | Jugadores | De qué va |
|---|---|---|
| **Dibuja y adivina** | 2 a 6 | Pictionary: uno dibuja en el móvil y los demás adivinan mirando la tele. Con 2, en equipo (8 rondas y un título final). De 3 a 6, todos contra todos: el dibujante rota, todos adivinan a la vez y quien antes acierta, más puntos; clasificación con medallas. Pistas, palabras secretas para los demás y galería de dibujos en PNG. |
| **El Infiltrado** | 3 a 6 | Deducción: todos ven en el móvil el lugar secreto y su papel… menos el infiltrado. Por turnos os hacéis preguntas en voz alta (la tele dice a quién le toca); cada uno puede acusar una vez por ronda (hace falta que todos digan «Sí») y el infiltrado puede arriesgarse con «¡Sé el lugar!». Si se acaba el tiempo, votación final. Carta tapada en el móvil, 40 lugares más los vuestros, y clasificación. |
| **Pong** | 2 a 4 | El clásico, con el móvil como pala, a 60 FPS en la tele. Con 3 o 4, por parejas: dos palas por lado, como en el futbolín. |
| **Reflejos** | 2 a 6 | El juego de ejemplo: la tele dice «¡YA!» y gana el punto quien antes toque su móvil. Al mejor de 5. |

El menú de la tele muestra para cuántos es cada juego y, si no encaja con los
que sois, lo pone en gris con el motivo («De 2 a 4 jugadores · sois 6»).

## Pantallas compatibles

| Pantalla | Estado | Cómo |
|---|---|---|
| LG webOS (probado en webOS 22) | ✅ sin PC (la tele es el servidor) | App instalada con el modo desarrollador; el servidor de los juegos va dentro de la tele. Desde el PC: instalar, abrir, estado, avisos, botones, capturas y medir FPS. También en modo pc (`--modo pc`). |
| Navegador (cualquier tele, proyector o portátil con navegador) | ✅ | Abrir la dirección que muestra `game-to-tv start`. Nada que instalar. |
| Amazon Fire TV | 🔜 | De momento, con el driver «Navegador» y el navegador Silk. Plan en [src/drivers/firetv/README.md](src/drivers/firetv/README.md). |
| Samsung Tizen | 🔜 | Pendiente (ver [docs/roadmap.md](docs/roadmap.md)). |
| Android TV / Google TV | 🔜 | Pendiente. |

## Inicio rápido

Necesitas un PC (Windows, macOS o Linux) con **Node.js 18 o superior** en la
misma red que la tele y los móviles. Con una tele LG, el PC solo se usa para
instalar la app ([más abajo](#lg-webos)); para cualquier otra pantalla:

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
game-to-tv tv install salon             # instala la app CON el servidor dentro (modo tele)
game-to-tv tv open salon                # o ábrela con el mando: «Juegos del Salón»
```

Desde ese momento **el PC ya no hace falta**: al abrir «Juegos del Salón», la
tele arranca su propio servidor (puerto 8090) y el QR apunta a la tele.
`game-to-tv tv status salon` comprueba desde el PC que responde.

Instalar la app necesita el **modo desarrollador** de LG (gratis, con una
cuenta de desarrollador) y `ares-cli`. Si falta algo, `tv install` te dice los
pasos exactos. **Ojo**: si la sesión de Developer Mode caduca, la app
desaparece de la tele; ábrela de vez en cuando y pulsa *Extend*. Guía
completa, con el modo tele y el modo pc: [docs/tele-lg.md](docs/tele-lg.md).

¿Prefieres que el servidor siga en el PC (por ejemplo, para desarrollar)?
`game-to-tv tv install salon --modo pc` y luego `game-to-tv start --abrir salon`.

¿Por qué una app y no el navegador de la tele? El navegador de webOS se quedaba
atascado en páginas que no cargaban a la primera. La app espera a que el
servidor responda y entonces abre los juegos.

### Cualquier otra pantalla con navegador

```bash
game-to-tv tv add proyector 192.168.1.60 --driver browser
game-to-tv tv open proyector            # te recuerda la dirección (y un QR)
```

## Cómo se juega

1. Cada jugador escanea el QR de la tele, escribe su nombre y pulsa «Unirse»
   (hasta 6; cada uno con su color). Si alguien pierde la conexión, su sitio
   se le guarda 30 s.
2. Se elige juego con el mando de la tele (◀ ▶ y OK) o desde cualquier móvil.
3. En cualquier juego, «Menú» en el móvil (o **Atrás** en el mando) vuelve al
   menú, con confirmación.

Los dibujos de «Dibuja y adivina» se guardan en PNG en `~/.game-to-tv/galeria`
y se ven en `http://IP-DEL-PC:3000/galeria`. En modo tele se guardan en la tele
si encuentra una carpeta con permiso de escritura (`tv status` dice cuál) y se
ven en `http://IP-DE-LA-TELE:8090/galeria`; si no, se ven igualmente al final
de cada partida.

**Modo ambiente**: `http://IP-DEL-PC:3000/ambiente` muestra un pase de las
fotos de `~/.game-to-tv/ambiente` con un reloj (hora de Madrid por defecto). Sin
fotos, muestra un fondo tranquilo. En LG: `game-to-tv tv open salon --ruta /ambiente`.

## Comandos

| Comando | Para qué |
|---|---|
| `game-to-tv start [--port 3000] [--host-ip IP] [--jugadores 6] [--galeria DIR] [--abrir TELE]` | Arranca el servidor (6 huecos de jugador por defecto, de 2 a 8) |
| `game-to-tv doctor` | Revisa Node, puerto, IP, cortafuegos de Windows, ares-cli y teles (no cambia nada) |
| `game-to-tv tv scan` | Busca teles (LG por SSDP) |
| `game-to-tv tv add NOMBRE IP [--driver webos\|browser]` · `tv list` · `tv remove NOMBRE` | Gestiona las teles |
| `game-to-tv tv pair NOMBRE` | Empareja (aviso en la tele) |
| `game-to-tv tv install NOMBRE [--modo tele\|pc] [--server-url URL] [--puerto 8090] [--jugadores 6] [--solo-ipk]` · `tv ipk` | Crea e instala la app (LG: modo tele por defecto, con el servidor dentro) |
| `game-to-tv tv open NOMBRE [--ruta /ambiente]` | Abre los juegos en la tele |
| `game-to-tv tv status NOMBRE [--logs]` | ¿Responde el servidor de dentro de la tele? Versión, Node, galería y registro |
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
el hub. Guía paso a paso con un juego completo de ejemplo («Reflejos», de 2 a
6 jugadores):
**[docs/crear-un-juego.md](docs/crear-un-juego.md)**.

## Más documentación

- [docs/arquitectura.md](docs/arquitectura.md): cómo encaja todo.
- [docs/crear-un-juego.md](docs/crear-un-juego.md): tu propio juego en una tarde.
- [docs/drivers.md](docs/drivers.md): cómo dar soporte a otra marca de tele.
- [docs/tele-lg.md](docs/tele-lg.md): guía completa para LG (modo tele y modo pc, modo desarrollador incluido).
- [docs/solucion-problemas.md](docs/solucion-problemas.md): cortafuegos, IP, FPS, salvapantallas, YouTube, iconos…
- [docs/roadmap.md](docs/roadmap.md): lo que viene.
- [CHANGELOG.md](CHANGELOG.md): cambios de cada versión.
- [CONTRIBUTING.md](CONTRIBUTING.md): cómo colaborar.

## Desarrollo

```bash
npm install
npm test               # servidor, juegos (con 2, 3, 4 y 6 móviles falsos, «sin chivatazos» incluido), drivers y servicio de la tele; sin red ni tele real
npm run check          # navegador en ES2019 (Chromium 87) y servidor de la tele compatible con Node 12
npm run test:node12    # todas las pruebas con Node 12, como el de la tele (lo descarga con npx)
npm run test:browser   # pruebas con Chromium sin pantalla (si Playwright está instalado)
```

## English summary

**game-to-tv** turns the living-room TV into a party-game screen while
everyone's phone becomes the controller (scan a QR code, no app install). A
small Node.js server (HTTP + WebSocket on one port) runs either INSIDE an LG
webOS TV (as a JS service of the launcher app, on the TV's own Node 12, port
8090: no PC needed to play) or on a PC on the home LAN. Games are self-contained folders (`src/games/<id>/`: manifest, server
module, TV view, phone view); the hub handles players, reconnection, the menu
and the QR. *Drivers* get the game screen onto TVs: the LG webOS driver
discovers TVs (SSDP), pairs over SSAP, builds and installs the launcher app
with its server service (pure-JS `.ipk` packaging or `ares-package`, installed
with LG's `ares-cli` in Developer Mode), launches it, checks the TV-hosted
server, sends toasts and remote buttons, takes screenshots and measures
real FPS through Chrome DevTools. A generic «browser» driver covers any screen
with a web browser; Fire TV, Tizen and Android TV are on the roadmap.
Rooms hold up to 6 players by default. Includes «Dibuja y adivina»
(Pictionary: cooperative for two, free-for-all with a rotating drawer for 3-6),
Pong (doubles for 3-4, foosball-style paddles), «El Infiltrado» (a social
deduction game for 3-6: everybody but the spy gets the secret location on
their phone) and a tiny example game (2-6). UI and docs are in Spanish. Quick start: `npx game-to-tv start`, then
`game-to-tv doctor` if anything fails to connect.

## Licencia

[MIT](LICENSE).
