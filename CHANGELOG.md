# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versiones según [SemVer](https://semver.org/lang/es/).

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

