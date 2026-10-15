# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versiones según [SemVer](https://semver.org/lang/es/).

## 0.7.0 - 2026-10-15

### Añadido

- **Rivales bot**: «🤖 Añadir rival» en el menú del móvil y cuatro niveles
  (Fácil, Normal, Difícil, Imposible). El rival entra en la sala como un
  jugador más, con nombre al azar (Paco, Lola, Maripili…) y color; la tele lo
  muestra con un robot y su nivel, y el móvil con «🤖 Paco · Difícil» y una ×
  para quitarlo. Se quedan en la sala de una partida a otra y se van cuando
  no queda nadie. Los juegos que aún no los admiten salen en gris («Este
  juego no admite rivales: quita los bots»); las tarjetas de los que sí,
  con «🤖 vs bot».
- **Tanques** contra el ordenador: el bot apunta con rebotes, esquiva, busca
  camino y elige solo si atacar, flanquear o retirarse. Corre dentro del
  servidor (también dentro de la tele) y cuesta muy poco por tick.
- Rivales también en **Motos de neón** (territorio y encierros), **Sumo**
  (simula empujones y esquiva embestidas), **Hockey de mesa** (predice el
  disco con rebotes y tira a puerta), **Pong** (calcula dónde llega la bola y
  juega con los ángulos; en parejas, cada bot defiende su pala), **Reflejos**
  (tiempo de reacción por nivel) y **2048** (carrera; de azar a expectimax).
  Dibuja y adivina y El Infiltrado no tienen rivales (dibujar o preguntar en
  voz alta no es cosa de bots).
- Para los juegos: `"bots": true` y un `bot.js` con `create(ctx)` (ver
  «Rivales bot» en docs/crear-un-juego.md), ayudas en `src/games/bot-kit.js`
  y `test/helpers/bot-arena.js` para probar bots con un reloj virtual.
- `tools/bot.js`: un bot de cualquier juego desde fuera, como un móvil
  (`--rival NIVEL` para ver bot contra bot). Sustituye a `tools/bot-tanques.js`.

### Cambiado

- `/solo`: solo los mandos (clase `g2t-ctl`) son translúcidos; los paneles
  del móvil (final, pausa, ayuda) son opacos y tapan la tele, y la barra de
  arriba es compacta. Antes se mezclaban la pantalla final de la tele y la
  del móvil.
- `/info` cuenta aparte las personas (`players`, `connected`) y los bots
  (`bots`).

## 0.6.0 - 2026-10-15

### Añadido

- **Sección «1 contra 1»** en el menú (campo `section` del manifiesto): una
  tarjeta en la fila principal que abre una fila con sus juegos; en el móvil,
  un grupo que se abre solo cuando sois 2.
- Cuatro duelos para 2 jugadores: **Tanques** (balas que rebotan, a 5),
  **Motos de neón** (estelas, a 5), **Sumo** (empujones en un círculo que
  encoge, al mejor de 5) y **Hockey de mesa** (maza con el dedo, a 7). Todo el
  juego en el servidor a 60 Hz, estado a 30 Hz e interpolación en la tele.
- **«Solo con el móvil»** (`/solo`): el móvil hace de pantalla y de mando.
- `tools/bot-tanques.js`: rival experimental para Tanques (conduce, apunta
  con rebotes y esquiva; se dirige con `orden.json`).
- Tele: `?escala=N` para encoger la pantalla a mano (se recuerda) y `?info`
  para ver tamaños, zoom y navegador.

### Cambiado

- Las descripciones de las tarjetas del menú se encogen hasta caber en 3 líneas.
- Las pruebas ya no dependen del número de juegos.

### Corregido

- La tele escala con el *visual viewport*: Amazon Silk (Fire TV) mostraba la
  pantalla con mucho zoom.

- `tv perf` en Windows medía bien pero no terminaba y dejaba `ares-inspect`
  en marcha: ahora se para todo el árbol de procesos (`taskkill /T`).

## 0.5.0 - 2026-10-14

### Añadido

- **«2048»** (de 1 a 6 jugadores), inspirado en el 2048 clásico y escrito
  desde cero (código, colores e icono propios): desliza las fichas y junta
  números iguales hasta llegar a 2048.
  - Toda la lógica en el servidor: el tablero, las fichas nuevas (2 el 90 %
    de las veces, 4 el 10 %, solo tras un movimiento que cambie algo), cada
    ficha se junta como mucho una vez por movimiento y «Sin movimientos».
  - A solas: un tablero grande en la tele, puntos y «Récord» (el mejor de cada
    nombre, en `~/.game-to-tv/records-2048.json`; en modo tele, junto a la
    galería, y si no hay dónde escribir, en memoria). Al llegar a 2048,
    «¡Lo conseguiste!» y se puede seguir. «Nueva partida» en el móvil (con
    confirmación); al atascarse, «Otra» / «Menú».
  - De 2 a 6: carrera de 3 minutos (o hasta que todos se atasquen), un tablero
    por jugador en su color (2 en paralelo, 3-4 en 2x2, 5-6 en 3x2); quien se
    atasca espera con «Sin movimientos»; clasificación con medallas.
  - Mando en el móvil para mayores: zona grande para deslizar (los gestos
    diminutos no cuentan), 4 flechas grandes, una copia del tablero, «?» con
    «Cómo se juega» y nada de desplazar ni ampliar la página.
  - En la tele, las flechas del teclado o del mando LG mueven el tablero del
    jugador 1: con un portátil basta con unir un móvil. Fuera del juego las
    flechas siguen moviendo el menú, y Atrás/Esc vuelve al menú como siempre.
  - Animaciones con transformaciones CSS (deslizar y «pop»), sin sombras ni
    filtros: 60 FPS en la tele webOS emulada, también con 4 tableros.
- `test/2048.test.js` y `test/browser-2048.js` (1 jugador a 1920x1080 y
  1280x720, carrera de 4, FPS en webOS emulada).

### Cambiado

- El hub admite juegos de 1 jugador: la sala está «lista» en cuanto hay
  tantos móviles como el mínimo más bajo de los juegos (1 con «2048»), la tele
  saluda a quien juega a solas y los demás juegos siguen pidiendo su mínimo
  («Falta 1 jugador»). Si se va el último jugador, se vuelve al menú con un
  texto claro («… y no queda nadie»); «necesita al menos 1 jugador» en
  singular.
- Nueva opción `dataDir` del servidor (`api.dataDir` para los juegos) para
  datos pequeños que deben durar.

## 0.4.1 - 2026-10-14

### Añadido

- **Instaladores de un clic** en `instalar/`, para jugar sin saber nada
  técnico (sin terminal, sin git y sin Node.js instalado):
  - `Juegos-del-Salon-Windows.bat` (Windows 10/11): sin permisos de
    administrador, descarga el Node.js oficial portátil (22.23.3; x64, ARM64
    o x86; con su SHA-256 comprobado) en `%LOCALAPPDATA%\game-to-tv`, o usa
    un Node.js 18+ ya instalado; descarga los juegos de GitHub, hace
    `npm install --omit=dev` y arranca. Al volver a abrirlo, actualiza (y si
    algo falla o no hay Internet, sigue con la versión que había; la
    configuración de `~/.game-to-tv` no se toca). Crea el icono «Juegos del
    Salón» en el escritorio, que arranca sin descargar nada.
  - Cortafuegos de Windows: comprueba sin cambiar nada el perfil de red y las
    reglas. Si la red está como «Pública», falta la regla o hay reglas de
    bloqueo de Node.js, lo explica y pide permiso **una sola vez** para crear
    la regla «game-to-tv (TCP 3000)» (solo desde la red local, perfiles
    Privado y Público, solo para ese `node.exe`) y, si se acepta, marcar la
    red como Privada. Si se dice que no, sigue y explica qué no funcionará.
  - `Juegos-del-Salon-Mac.command`: lo mismo en Mac, en
    `~/Library/Application Support/game-to-tv` (Apple Silicon o Intel, sin
    admin ni Homebrew).
  - Mensajes en castellano llano; ante cualquier fallo, «Haz una foto de esta
    pantalla y envíasela a quien te pasó el archivo».
- [Guía de una página para la familia](docs/guia-familia.md): qué pulsar en
  SmartScreen, en el aviso de Windows y en Gatekeeper, HDMI y el botón
  «Source» de la Samsung (o su app «Internet»), el QR, qué juegos van con 2 y
  qué hacer si un móvil no conecta.
- `game-to-tv start --navegador`: abre la pantalla de la tele en el navegador
  del PC, a pantalla completa (Chrome o Edge en una ventana propia; si no, el
  navegador predeterminado). Pensado para un portátil conectado por HDMI.
- `game-to-tv start --sencillo`: instrucciones cortas («Deja esta ventana
  abierta mientras jugáis», la dirección para el navegador de la tele, «Para
  salir, cierra esta ventana») en vez de la lista técnica.
- Pruebas de los instaladores en `npm test` (finales de línea, versión y
  SHA-256 de Node.js, URLs, la regla del cortafuegos; con `pwsh`, el paso del
  cortafuegos con los cmdlets de Windows simulados) y un ensayo completo en
  Linux: `bash test/instalar/simular.sh`.

### Cambiado

- Abrir `start` dos veces con `--navegador` o `--sencillo` ya no da error de
  puerto ocupado: dice que ya estaba en marcha y abre la pantalla.

## 0.4.0 - 2026-10-13

### Añadido

- **El Infiltrado** (3 a 6 jugadores), un juego de deducción: todos reciben en
  el móvil el lugar secreto y un papel distinto dentro de él… menos uno, el
  infiltrado, que solo ve «Eres el infiltrado».
  - **Carta tapada** en el móvil, con pinta de expediente: se ve mientras se
    mantiene pulsada (o 3 s con «Ver») y «Ocultar» la tapa al momento. Tapada
    es idéntica para todos; el «¡Sé el lugar!» del infiltrado está dentro.
  - **Turnos**: la tele dice «Le toca preguntar a Ana»; Ana elige en el móvil a
    quién pregunta (nunca a quien le acaba de preguntar) y la tele muestra
    «Ana pregunta a Berto» y las 6 últimas preguntas.
  - **Reloj** de 6 min con 3-4 jugadores y 8 con 5-6, o 4/6/8/10 min elegidos
    en el menú por cualquiera; en rojo los últimos 30 s; pausa si alguien se
    desconecta.
  - **Acusaciones**: una por jugador y ronda; votan Sí/No todos menos el
    acusado (30 s) y hace falta unanimidad. Si no prospera, la tele solo dice
    el recuento («3 a favor, 1 en contra»). El reloj se para mientras.
  - **«¡Sé el lugar!»**: el infiltrado elige en la lista completa y la ronda
    acaba al momento. La tele muestra siempre la rejilla de lugares posibles;
    en el móvil se pueden tachar como notas.
  - **Tiempo agotado**: votación final de todos (45 s, nadie a sí mismo); gana
    la mayoría y el empate salva al infiltrado. Si lo pillan, aún tiene 30 s
    para adivinar el lugar y llevarse la ronda.
  - **Puntos**: infiltrado +2 si se salva o adivina al final, +4 si acierta con
    «¡Sé el lugar!»; si lo pillan o falla, los demás +1 (y +2 quien lo acusó).
  - Tantas rondas como jugadores (cada uno empieza preguntando una vez; quien
    abre la partida rota). Revelación con la carta que da la vuelta (solo
    `transform`, a 60 FPS en una tele webOS emulada), los papeles de todos y
    los puntos; clasificación con medallas, «Jugar otra vez» y «Menú».
  - 40 lugares propios con 6 papeles cada uno, y hasta 5 **lugares propios**
    por jugador desde el menú (con o sin papeles; si no, papeles genéricos).
    Nunca le toca a su autor ser el infiltrado en su propio lugar.
  - **Sin chivatazos**: el lugar y los papeles nunca llegan a la tele antes de
    la revelación, ni el lugar al móvil del infiltrado; cada papel solo a su
    jugador; las cartas tienen los mismos campos y el mismo tamaño para todos
    y el resto de mensajes es idéntico para la tele y todos los móviles, así
    que nada distingue al infiltrado; los votos son anónimos (ni siquiera
    vuelven a quien votó) y el registro del servidor no los menciona.
  - Si el infiltrado se va del todo, la ronda acaba sin puntos («El infiltrado
    ha abandonado») y se sigue; si se va otro, sale de los turnos y las
    votaciones. Con menos de 3, vuelta al menú con el motivo.
  - «?» en el móvil: cómo se juega, en 8 líneas (campo `howTo` del manifiesto).
- Pruebas: `test/infiltrado.test.js` (reglas, y partidas con 3, 4 y 6 móviles
  falsos que revisan en cada ronda que no haya chivatazos) y
  `test/browser-infiltrado.js` (4 iPhone emulados a 1920x1080, 1280x720 y en
  una tele webOS emulada, con FPS). `npm run test:browser` la incluye.

### Cambiado

- Hub: al volver al menú porque se ha ido alguien y no quedan bastantes
  jugadores, el `ev` `menu` lleva `text` con el motivo y la tele y los móviles
  lo muestran.
- Los manifiestos pueden llevar `howTo` (lista de frases «Cómo se juega»), que
  llega a la tele y a los móviles con el resto de datos del juego.

## 0.3.0 - 2026-10-13

### Añadido

- **Grupos de hasta 6 jugadores.** La sala tiene 6 huecos por defecto en modo
  pc y en modo tele (`--jugadores N`, de 2 a 8; `tv install --jugadores N`,
  `players` en `tv-service.json`, `G2T_JUGADORES`).
- **Dibuja y adivina de 2 a 6.** Con 2, el modo en equipo de siempre. De 3 a 6,
  «todos contra todos»: el dibujante rota y los demás adivinan a la vez en el
  móvil.
  - Puntos por orden de acierto: `round((100 + 3 × segundos) × 1 / 0,8 / 0,65 /
    0,5 / 0,4) + bonus de dificultad`. El dibujante gana `200 / acertantes
    posibles` por cada acierto, más el bonus con el primero.
  - La ronda acaba cuando aciertan todos o se acaba el tiempo. Cada jugador
    dibuja 2 veces con 3-4 jugadores y 1 con 5-6 (`DIBUJA_VUELTAS`).
  - Sin destripes: la palabra y el texto de un acierto no llegan a la tele ni a
    otros móviles («Ana ha acertado»). «¡Casi!» es privado y los errores salen
    en la tele con nombre y color. Tras acertar, el móvil dice «¡Acertaste!
    Espera a los demás» y no deja intentarlo más.
  - Las palabras secretas de cada uno pueden salirle a cualquier otro
    dibujante; su autor no adivina esa ronda.
  - Si quien dibuja se va del todo, se desvela la palabra y sigue el siguiente.
  - Final con clasificación con medallas y la galería con quién dibujó cada
    dibujo.
- **Pong de 2 a 4.** Con 3 o 4, por parejas: dos palas por lado como en el
  futbolín (portería y delantera), cada una de un jugador. Con 3, quien juega
  solo tiene una pala de portería más larga. Puntos por equipo, a 7. La tele
  muestra los equipos y el nombre de cada pala; el móvil, cuál es la tuya.
- **Reflejos de 2 a 6**, con la tele preparada para 6 marcadores.
- Menú de la tele: rejilla de jugadores con nombre y color (de 1 a 6), y en
  cada tarjeta el rango de jugadores y, si no encaja, el motivo. En el móvil,
  los jugadores de la sala con su color y el motivo en los juegos que no se
  pueden elegir.
- Hub: `onPlayerLeft(i)` para que un juego siga cuando alguien se va del todo
  (`ev` `left`), y avisos en español a la tele y a todos los móviles al elegir
  un juego que no encaja (`ev` `need2`/`toomany` con `text`, `min`, `max`, `n`).
- `docs/crear-un-juego.md`: sección «De 2 a 6 jugadores».
- Pruebas: `pong.test.js`, `grupo.test.js` y `dibuja-grupo.test.js` (3, 4 y 6
  móviles falsos), y `browser-grupo.js` (sala de 6, Pong a 4 y Dibuja a 4 a
  1920x1080, 1280x720 y en una tele webOS emulada).

### Cambiado

- Los mensajes del Pong y de Dibuja llevan campos nuevos (ver
  `docs/arquitectura.md`); con 2 jugadores todo funciona como antes.
- La prueba de navegador de siempre fija la sala de 2 (`--jugadores 2`).

### Arreglado

- Al compactar huecos, la tele podía decir que el juego lo había elegido otro
  jugador.
- Una comprobación de `reflejos.test.js` fallaba a veces por una carrera.

## 0.2.0 - 2026-10-13

### Añadido

- **Modo tele (LG webOS): el servidor de los juegos va dentro de la tele.** Al
  abrir «Juegos del Salón», la app arranca su servicio JS (`<appId>.service`,
  con el Node.js 12 de la tele) y este pone en marcha el mismo servidor de
  siempre en el puerto **8090**. El QR apunta a la IP de la tele. El PC solo
  hace falta para instalar o actualizar la app (`game-to-tv tv install`).
  - Métodos del servicio: `start` (idempotente), `status`, `heartbeat`
    (suscripción cada 5 s), `stop` y `logs` (anillo con las últimas líneas).
  - Actividad `keepAlive` mientras hay uso y apagado automático tras 15 min sin
    pantalla ni jugadores (`--apagado MIN`).
  - Galería de dibujos en la primera carpeta de la tele en la que se puede
    escribir; si no hay ninguna, no se guardan PNG pero la galería del final de
    la partida se ve igual.
  - La app muestra «Arrancando los juegos…», espera al servicio y al servidor
    con reintentos, y si algo falla explica qué hacer (incluida la caducidad
    del modo desarrollador). Con `--server-url`, un servidor de PC de reserva
    (tecla ▲).
- `game-to-tv tv install` y `tv ipk` con `--modo tele|pc` (en LG, `tele` por
  defecto), `--puerto` (8090) y `--apagado`.
- `game-to-tv tv status NOMBRE [--logs] [--json]`: estado del servidor de
  dentro de la tele (versión, Node, galería, actividad y registro).
- `game-to-tv doctor` dice, para cada tele LG, si su servidor responde.
- El empaquetador `.ipk` en JavaScript admite servicios
  (`usr/palm/services/<id>/` y `services` en `packageinfo.json`), como
  `ares-package`.
- `/info` incluye `mode` (`pc` o `tele`), `version` y la actividad; en modo
  tele, también `/logs`.
- `public/lib/tvservice.js`: la página de la tele mantiene su propia
  suscripción `heartbeat` con el servicio (no hace nada fuera de webOS).
- Comprobación de compatibilidad con Node 12 del código que va dentro de la
  tele (`npm run check`) y `npm run test:node12` (todas las pruebas con Node
  12; también en la integración continua).
- Pruebas: servicio con un `webos-service` falso, paquete con servicio que se
  extrae y arranca fuera del proyecto, y el lanzador en modo tele en Chromium
  con un `PalmServiceBridge` falso.
- Este archivo de cambios.

### Cambiado

- La app de LG es la misma plantilla para los dos modos; el modo pc se
  comporta como en 0.1.
- `tv open --navegador` en modo tele abre el servidor de la propia tele.
- Los textos de la tele y del modo ambiente ya no dan por hecho que el
  servidor es un PC.

### Arreglado

- Dos pruebas del driver de webOS esperaban la versión 0.1.0 escrita a mano.

## 0.1.1 - 2026-10-13

### Arreglado

Probado en un PC con Windows real:

- `tv scan`: la búsqueda SSDP sale por cada red del PC (con WSL o una VPN,
  Windows la mandaba por la red equivocada).
- `doctor`: sin permisos de administrador avisa en vez de dar un falso error
  del cortafuegos.
- `ares-cli` en Windows: un único comando ya entrecomillado (aviso DEP0190 de
  Node 24 o posterior).
- `tv info` oculta el número de serie de la tele.

## 0.1.0 - 2026-10-13

### Añadido

- Primera versión: servidor hub (HTTP + WebSocket en un puerto), «Dibuja y
  adivina», Pong y el juego de ejemplo «Reflejos»; drivers de LG webOS
  (emparejar, instalar la app lanzadora, abrir, avisos, botones, capturas,
  FPS) y navegador; `doctor`; documentación en español.

