# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versiones según [SemVer](https://semver.org/lang/es/).

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

