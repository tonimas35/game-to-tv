# Arquitectura

El mismo servidor (`src/server/`, HTTP + WebSocket en un puerto) puede correr
en dos sitios:

```
 MODO PC (cualquier pantalla con navegador; desarrollo; reserva)
                 ┌──────────────────────── PC (Node.js ≥ 18) ────────────────────────┐
                 │  game-to-tv start                                                  │
  Móviles ──────▶│  HTTP + WebSocket en UN puerto (3000)                              │
  (/m + QR)      │   ├─ src/server/index.js   rutas, shells, QR, galería, ambiente    │
                 │   ├─ src/server/hub.js     huecos, reconexión, menú, bucle 60 Hz   │
  Tele ─────────▶│   └─ src/games/<id>/       un juego = una carpeta                  │
  (/ = shell)    │                                                                    │
                 │  game-to-tv tv …  ──▶ src/drivers/<driver>/  (LG webOS, navegador) │
                 └────────────────────────────────────────────────────────────────────┘

 MODO TELE (LG webOS: la tele es el servidor; el PC solo instala)
                 ┌──────────────────────── Tele LG (webOS 22) ────────────────────────┐
                 │  app «Juegos del Salón» (file://…/index.html, modo tele)           │
                 │    1. luna://io.gametotv.launcher.service/start (PalmServiceBridge)│
                 │    2. sondea http://127.0.0.1:8090/qr.svg  →  3. abre esa página   │
                 │                    │                               ▲ heartbeat     │
                 │                    ▼                               │ (tvservice.js)│
                 │  servicio JS (Node 12 de la tele, src/tv-service/) │               │
                 │    actividad keepAlive · apagado tras 15 min sin uso               │
  Móviles ──────▶│    el MISMO servidor: src/server + src/games, puerto 8090          │
  (QR → IP de    │    HOST_IP = IP de la tele (eth0 / wlan0)                          │
   la tele:8090) └────────────────────────────────────────────────────────────────────┘
                     ▲ game-to-tv tv install (app + servicio en un .ipk, ares-cli)
                     ▲ game-to-tv tv status / doctor  (GET :8090/info)
                   PC
```

## Piezas

| Carpeta | Qué hay |
|---|---|
| `bin/game-to-tv.js` | Entrada del CLI. |
| `src/cli/` | Comandos: `start`, `doctor` (con el análisis del cortafuegos), `tv …`. Analizador de argumentos mínimo, sin dependencias. |
| `src/config.js` | `~/.game-to-tv/config.json` (teles, clave de emparejamiento, carpetas). Se escribe con permisos `0600`. `GAME_TO_TV_HOME` la mueve. |
| `src/server/` | `index.js` (HTTP, WebSocket, rutas; modo `pc` o `tele`), `hub.js` (jugadores y juegos), `net.js` (IP de la red local), `ambient.js` (modo ambiente). |
| `src/tv-service/` | El servidor del modo tele: `core.js` (métodos `start`, `status`, `heartbeat`, `stop`, `logs`; IP de la tele, carpeta de la galería, apagado por inactividad), `service.js` (la entrada que ejecuta webOS) y `android.js` (la que ejecuta la app de Android con nodejs-mobile). |
| `src/games/` | `index.js` (registro de juegos) y una carpeta por juego. |
| `public/` | `tv.html` y `m.html` (los *shells*), `ambiente.html`, `keepalive.mp4` y `lib/` (ayudas compartidas del navegador). |
| `src/drivers/` | Interfaz y registro de drivers, y uno por tipo de tele. |
| `apps/webos-launcher/` | Plantilla de la app lanzadora para LG (una sola, para el modo tele y el modo pc). |
| `apps/android-tv/` | App de Android TV / Google TV / Fire TV (Gradle, Java): `WebView` y servicio con Node.js (nodejs-mobile) en el proceso `:node`. La compila `.github/workflows/android.yml`. |
| `scripts/` | `check-browser-js.js` (ES2019), `check-node12.js` (el servidor de la tele, compatible con Node 12) y `make-icons.js`. |
| `test/` | Pruebas sin dependencias de test (scripts de Node con `check()`). |

## El servidor

- **Un solo puerto** para todo (páginas, QR, WebSocket en `/ws`): solo hay que
  abrir ese puerto en el cortafuegos.
- **Archivos leídos en cada petición** y `Cache-Control: no-store`: editar una
  vista solo requiere recargar la página (y la tele nunca se queda con una
  versión vieja en caché).
- **Shells con inyección**: al servir `/` y `/m`, el servidor sustituye
  `<!--@boot-->` por la lista de juegos y las secciones del menú (`window.G2T_BOOT`) y `<!--@games-->`
  por los `<script>`/`<link>` de cada juego. Así las vistas ya están cargadas
  cuando llega el primer mensaje (sin carreras al reconectar a mitad de
  partida) y el shell no conoce ningún juego concreto.
- **Bucle a 60 Hz con paso fijo** (`hub.js`): llama a `tick(1/60)` del juego
  activo y luego a `flush()` para enviar el estado. WebSocket sin compresión
  (`perMessageDeflate: false`) por latencia; `TCP_NODELAY` lo pone `ws`.
- **Detección de IP**: puntúa las interfaces (192.168.x > 10.x > 172.16-31.x;
  penaliza VPN, Docker, WSL, Hyper‑V, 169.254…). `--host-ip`/`HOST_IP` manda.
  En la tele: `eth0`, luego `wlan0` (nunca Wi‑Fi Direct `p2p0`).
- **`/info`** dice `{ mode: 'pc' | 'tele', version }`, las direcciones y la
  actividad (pantallas y jugadores). En modo tele añade `tele` (Node, carpeta
  de la galería, minutos sin uso) y sirve `/logs`.
- **Mismo origen**: la tele y los móviles usan la dirección desde la que se
  cargó la página (`location.host`), nunca la del PC: así el mismo código sirve
  en el PC y en la tele.

## El modo tele (`src/tv-service/`)

- **Arranque**: `start` es idempotente (dos llamadas a la vez = un servidor) y
  crea la actividad `keepAlive`: sin ella, webOS cierra el servicio unos
  segundos después de la última llamada. Si la IP de la tele ha cambiado, el
  servidor se reinicia para que el QR sea el bueno.
- **Apagado**: cada 30 s mira si hay alguna pantalla, jugador o suscripción
  `heartbeat`; tras 15 min sin nada (`--apagado MIN`), cierra el servidor y
  completa la actividad para que webOS pueda terminar el proceso.
- **Jugadores**: 6 huecos por defecto (`players` en `tv-service.json`,
  `G2T_JUGADORES`; `tv install --jugadores N`).
- **Galería**: prueba carpetas hasta encontrar una donde escribir (`$HOME`,
  `/media/developer/temp`, la del servicio, `os.tmpdir()`). Si ninguna sirve,
  no guarda PNG, pero la galería del final de la partida se ve igual.
- **Registro**: anillo con las últimas 300 líneas (`logs`, `/logs`,
  `tv status --logs`).
- **Paquete** (`src/drivers/webos/bundle.js`): solo el código del servidor, los
  juegos, `public/` y las dependencias de producción (`ws`, `qrcode`, `pngjs`),
  sin pruebas, documentación, CLI ni drivers. Nunca `webos-service` (lo pone
  la tele). Unos 200 KB en total.
- **Node 12**: la tele trae Node 12.21. `npm run check` analiza el paquete real
  (acorn en ES2019 + APIs prohibidas) y las pruebas arrancan el servicio
  empaquetado; `npm run test:node12` lo pasa todo con Node 12.

## El modo tele en Android (`apps/android-tv/`, `src/tv-service/android.js`)

```
  ┌──────────────────────── Tele Android (TV, Google TV, Fire TV) ─────────────────────┐
  │  MainActivity (proceso principal): WebView a pantalla completa                     │
  │    1. «Preparando los juegos…» (assets/loading.html)                               │
  │    2. ¿/info responde? no → startForegroundService(NodeService, IP de Java)        │
  │    3. sondea http://127.0.0.1:8090/info  →  4. abre http://127.0.0.1:8090/        │
  │    al salir: about:blank (la página deja de contar como pantalla)                  │
  │                                                                                    │
  │  NodeService (proceso :node, servicio en primer plano)                             │
  │    copia assets/nodejs-project → files/ · node::Start(main.js --host-ip …)         │
  │    src/tv-service/android.js → core.js: el MISMO servidor, puerto 8090             │
  │    15 min sin pantalla ni jugadores → cierra y SIGKILL al proceso :node            │
  └────────────────────────────────────────────────────────────────────────────────────┘
```

- **Un proceso para Node**: nodejs-mobile solo puede arrancar Node una vez
  por proceso. Al apagarse el servidor, el proceso termina; la próxima vez que
  se abre la app se arranca otro. Si sigue vivo, se reutiliza.
- **La IP para el QR la da Java** (`ConnectivityManager`/`LinkProperties`
  de la red activa, cable antes que Wi‑Fi): `os.networkInterfaces()` no es
  fiable en Android. Si cambia, la app reinicia el servidor.
- **Datos** en `files/datos/` (galería, récords, `estado.json` con el
  estado o el error del arranque).
- **Teclas**: el `WebView` recibe flechas y Enter; Atrás manda Escape a la
  página o, en el menú principal (`window.__tv.atMainMenu()`), sale con dos
  pulsaciones seguidas.

## El hub (`src/server/hub.js`)

- **Huecos de jugador** (6 por defecto, `--jugadores N` de 2 a 8; en modo tele,
  `players` en `tv-service.json`). Cada uno con su color (8 distintos). Cada
  móvil guarda un `cid` en `sessionStorage`; si se reconecta con el mismo `cid`
  recupera su hueco. Un hueco desconectado se guarda `SLOT_HOLD_MS` (30 s).
  Los huecos pueden quedar con saltos (alguien sale): los juegos usan
  `api.players()`.
- **Elegir juego**: comprueba `minPlayers`/`maxPlayers` del manifiesto y que
  todos estén conectados. Si no, manda a la tele y a **todos** los móviles
  `{ t: 'ev', k: 'need2' | 'toomany', game, title, min, max, n, by, name, text }`
  (`text` es la explicación en español; `k`, `min`, `max` y `title` son los de
  siempre). Si hay alguien en un hueco por encima del máximo del juego (el Pong,
  hasta 4, con alguien en el 6), los huecos se **compactan** antes de empezar.
- **Alguien se va del todo** («Salir» o no vuelve en `SLOT_HOLD_MS`) durante una
  partida: si quedan al menos `minPlayers` y el juego define `onPlayerLeft(i)`
  sin devolver `false`, la partida sigue (`{ t: 'ev', k: 'left', slot, name }`);
  si no, vuelta al menú como antes.
- **Mensajes**: los del hub (`hello`, `join`, `leave`, `pick`, `menu`, `ping`)
  los gestiona el hub; los que un juego declara en `lobby.messages` van a su
  manejador de menú; el resto, al juego activo con `who` = hueco (0…) o `-1`
  para la tele.
- **Estado del hub** (`{t:'hub'}`): pantalla actual, número de huecos
  (`slots`), jugadores (nombre, color, conectado, segundos de reserva, `badges`
  de los juegos), quién eligió el juego. Se reenvía al cambiar y como mucho una
  vez por segundo.

- **Rivales bot** (`src/server/bots.js`, niveles y nombres): un bot ocupa un
  hueco normal sin socket y siempre conectado (`{ t: 'bot.add', level }` y
  `{ t: 'bot.remove', slot }` desde un móvil, solo en el menú). Si el juego
  tiene `"bots": true`, al empezar se crea un bot por rival con su `bot.js`:
  - **Lo que ve**: `sendTvs`, `sendSlot`, `sendPhones` y `broadcast` le pasan
    al bot lo que va a la tele (`onTv`) y a su hueco (`onSlot`). Cada texto se
    convierte con `JSON.parse` **una sola vez** (una caché de un elemento:
    un `broadcast` va a la tele y a los móviles con el mismo texto) y el mismo
    objeto va a todos los bots. Sin bots en marcha no se hace nada de esto.
  - **Lo que hace**: `ctx.send(msg)` lo guarda en una cola (como texto); al
    principio del tick siguiente el hub lo entrega a `onMessage(hueco, msg)`
    del juego, igual que un mensaje de móvil (los del hub se ignoran).
  - **Cada tick**: huecos caducados → cola de los bots → `tick` del juego →
    `tick(dt)` de cada bot; luego `flush` del juego (el estado sale hacia la
    tele y los bots).
  - `api.tvs.size` cuenta una tele más mientras juegan bots; `counts()` (el
    apagado por inactividad del modo tele) solo cuenta personas.
  - Los bots se paran al volver al menú y se van cuando no queda nadie.

Protocolo completo: comentario al principio de `src/server/hub.js`.

### Mensajes de los juegos para grupos (0.3)

Todo lo de antes sigue igual con 2 jugadores; se **añaden** campos:

- **Pong** (`src/games/pong/index.js`): `pmeta` lleva `mode` (`clasico` |
  `dobles`), `paddles` (`[{ slot, side, x, h, role }]`) y `teams`. En el estado
  `s`, `p` es la posición de **cada pala** por índice de pala (0 portería
  izquierda, 1 portería derecha, 2 delantera izquierda, 3 delantera derecha), y
  `p` (movimiento inmediato) usa `i` = índice de pala. `ev` `hit` lleva `slot`
  (jugador), `side` y `paddle`; `score` y `win`, `slot` = `side` (1 izquierda, 2
  derecha). Con 2 jugadores el índice de pala coincide con el de antes.
- **Dibuja y adivina** (`src/games/dibuja/index.js`): `dmeta` lleva `mode`
  (`coop` | `ffa`), `players`, `vueltas`; en `ffa`, además `scores` (por hueco),
  `guessers`, `correct` (`[{ slot, order, points }]`, sin texto), `author` y, al
  final, `ranking`. En `ffa`: `d.g` erróneo va a todos con `slot`; `casi` y `ok`
  solo a quien lo escribió (`mine: true`, y `ok` sin texto); `d.got` avisa a
  todos de un acierto; `d.reveal` lleva `results`, `drawerPoints`, `scores` y
  `reason` (`all` | `time` | `left`). `d.opts` marca las palabras secretas con
  `from` (su autor).

### El Infiltrado (0.4)

`src/games/infiltrado/index.js` (protocolo completo en su comentario):

- **`imeta`**: el estado público, **un único mensaje idéntico** para la tele y
  todos los móviles (`phase`, `round`, `asker`, `askedBy`, `history`, `clock`,
  `places` —la lista pública de lugares, ordenada, sin marcar el bueno—,
  `accUsed`, `acc`/`vote` con quién ha votado pero nunca qué, `accResult` con el
  recuento, `caught` en la última oportunidad y `result`/`ranking` solo en la
  revelación y al final).
- **`i.card`**: lo único privado, a cada jugador y en el mismo instante:
  `{ round, match, location, role, spy, pad }`. La del infiltrado lleva
  `location: null, role: null, spy: true`; `pad` (espacios) iguala el tamaño
  en bytes de todas las cartas de la ronda. Un móvil que se reconecta recibe
  la misma cadena otra vez.
- Mensajes de los móviles: `i.ask`, `i.accuse`, `i.vote`, `i.final`, `i.guess`
  (índice en `places`), `i.next`, `i.again`; en el menú, `i.places` (lugares
  propios, por jugador) e `i.cfg` (duración de la ronda, de la sala: se avisa a
  todos los móviles).
- El servidor no escribe en el registro quién es el infiltrado ni el lugar
  hasta la revelación (`/logs` se puede abrir en modo tele).
- `test/infiltrado.test.js` comprueba en cada ronda que la tele y todos los
  móviles (menos la carta) reciben exactamente los mismos mensajes, que las
  cartas tienen los mismos campos y tamaño, y que el lugar y los papeles no
  aparecen donde no deben.

Hub: al volver al menú porque se ha ido alguien y no quedan bastantes
jugadores, `{ t: 'ev', k: 'menu', reason, text }` lleva el motivo en español.

## Los clientes

`public/lib/` (ES2019, sin dependencias):

| Archivo | Para qué |
|---|---|
| `core.js` | Espacio `G2T`, utilidades de DOM, almacenamiento con respaldo en memoria, registro de vistas (`G2T.tv`, `G2T.phone`). |
| `canvas.js` | `G2T.capDpr()`: límite del tamaño real de los canvas (1280 px de ancho en webOS, `?res=N`). |
| `socket.js` | WebSocket con reconexión (espera exponencial hasta 5 s) y vigilancia de conexiones «zombis» (móviles que se duermen). |
| `keys.js` | Mando de la tele: flechas, OK (13), **Atrás (461)** y captura del `history.back()` de webOS. |
| `sound.js` | Sonidos sintetizados con WebAudio (nunca rompen nada si el audio está bloqueado). |
| `keepalive.js` | Evitar el salvapantallas de webOS (servicio luna si hay `PalmServiceBridge`, vídeo diminuto en bucle y un píxel que cambia). |
| `tvservice.js` | Modo tele: la página de la tele abre su propia suscripción `heartbeat` con el servicio (la del lanzador muere al navegar). No hace nada fuera de webOS ni con un servidor de PC. |

La **tele** (`tv.html`) dibuja un escenario fijo de 1920x1080 y lo escala a la
pantalla; cada juego añade su vista. El **móvil** (`m.html`) gestiona la
entrada, el menú, los avisos y la confirmación; cada juego añade su pantalla y,
si quiere, un panel en el menú.

## Drivers

Un driver sabe poner los juegos en un tipo de pantalla: descubrirla,
emparejarse, instalar una app, abrirla, controlarla, hacer capturas y medir el
rendimiento. Cada uno declara sus `capabilities` y el CLI explica en español
lo que no puede hacer. Detalles: [drivers.md](drivers.md).

## Decisiones (y por qué)

- **Sin framework** ni en el servidor ni en el navegador: la tele es lenta y
  vieja (Chromium 87); cuanto menos código, mejor. Dependencias: `ws`,
  `qrcode`, `pngjs`.
- **ES2019 en el navegador**, comprobado con `npm run check` (acorn + lista de
  APIs prohibidas). Nada de CDNs: todo funciona sin Internet.
- **Los juegos son carpetas** (manifiesto + servidor + vistas) en lugar de un
  sistema de plugins con npm: copiar una carpeta es la forma más fácil de
  empezar un juego.
- **App lanzadora en vez del navegador de la tele** en LG: el navegador se
  atascaba en páginas que fallaban al cargar; la app sondea `/qr.svg` y
  después navega al servidor.
- **El servidor dentro de la tele (modo tele)** en vez de un PC encendido: es
  el mismo código, empaquetado como servicio JS de la app. El PC queda para
  instalar, para pantallas sin app y como reserva.
- **Puerto 8090 en la tele**: el 3000 y el 3001 son del servicio SSAP de LG.
- **Empaquetado `.ipk` en JavaScript puro**: se puede crear la app sin
  instalar nada de LG. Para instalarla sí hace falta `ares-cli`.
- **Configuración fuera del repositorio** (`~/.game-to-tv/`): la clave de
  emparejamiento permite controlar la tele y nunca debe subirse.
- **Los PNG de la galería se dibujan en un `worker_thread`**: guardar nunca
  frena el juego.
